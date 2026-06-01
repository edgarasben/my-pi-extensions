import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type MemoryType = "unknown" | "fact" | "decision" | "preference" | "lesson" | "procedure" | "project_note" | "entity" | "event";
type MemoryStatus = "inbox" | "candidate" | "active" | "superseded" | "archived" | "rejected";
type MemoryBucket = "pinned" | "active" | "cold" | "archived";
type MemoryScope = "global" | "project" | "agent" | "user" | "source";
type MemorySensitivity = "public" | "internal" | "private" | "secret";

type MemoryFrontmatter = {
	id: string;
	type: MemoryType;
	status: MemoryStatus;
	bucket: MemoryBucket;
	confidence: number;
	scope: MemoryScope;
	project?: string;
	agent?: string;
	sensitivity: MemorySensitivity;
	durable: boolean;
	source: string;
	source_ref?: string;
	reason: string;
	created_at: string;
	task_tags: string[];
	links: string[];
};

type MemoryDocument = {
	frontmatter: MemoryFrontmatter;
	content: string;
	path: string;
};

type MemorySearchResult = {
	id: string;
	path: string;
	type: MemoryType;
	scope: MemoryScope;
	project?: string;
	score: number;
	reasons: string[];
	snippet: string;
};

type InjectionDecision = {
	timestamp: string;
	query: string;
	cwd: string;
	project?: string;
	inject: boolean;
	reason: string;
	confidence: number;
	topScore: number;
	selectedMemoryIds: string[];
	rejectedTopIds: string[];
};

type SessionMessage = {
	id: string;
	role: "user" | "assistant" | "system" | string;
	text: string;
	timestamp?: string;
};

type SessionTranscript = {
	path: string;
	sessionId?: string;
	cwd?: string;
	timestamp?: string;
	messages: SessionMessage[];
};

type DistilledMemoryCandidate = {
	content: string;
	type: MemoryType;
	reason: string;
	scope: MemoryScope;
	project?: string;
	confidence: number;
	sensitivity: MemorySensitivity;
	source_ref: string;
	task_tags: string[];
	links: string[];
};

type EvaluatedDistilledMemoryCandidate = DistilledMemoryCandidate & {
	evaluationReason: string;
};

type RejectedDistilledMemoryCandidate = {
	content: string;
	reason: string;
};

type DistillationResult = {
	dryRun: boolean;
	sessionsScanned: number;
	candidatesFound: number;
	candidatesAccepted: number;
	candidatesRejected: number;
	candidatesSaved: number;
	duplicatesSkipped: number;
	accepted: EvaluatedDistilledMemoryCandidate[];
	rejected: RejectedDistilledMemoryCandidate[];
	paths: string[];
};

type CompletionItem = {
	value: string;
	label?: string;
	description?: string;
};

type ReviewAction = "promote" | "reject" | "edit" | "next" | "quit";
type SearchBackend = "qmd" | "simple";

const QMD_MEMORY_COLLECTION = "pi-memory";
const DEFAULT_SESSION_DISTILL_LIMIT = 5;
const MAX_DISTILLED_CANDIDATES_PER_SESSION = 8;
const MEMORY_TYPES = ["unknown", "fact", "decision", "preference", "lesson", "procedure", "project_note", "entity", "event"] as const;
const MEMORY_SCOPES = ["global", "project", "agent", "user", "source"] as const;
const MEMORY_SENSITIVITIES = ["public", "internal", "private", "secret"] as const;

const MemorySaveParams = Type.Object({
	content: Type.String({ description: "Memory content to save. Must be durable and useful in future sessions." }),
	type: Type.Optional(Type.String({ enum: [...MEMORY_TYPES], description: "Kind of memory being saved." })),
	reason: Type.String({ description: "Why this memory is worth saving for future use." }),
	scope: Type.Optional(Type.String({ enum: [...MEMORY_SCOPES], description: "Where this memory applies." })),
	sensitivity: Type.Optional(Type.String({ enum: [...MEMORY_SENSITIVITIES], description: "Injection safety level. secret is rejected." })),
	confidence: Type.Optional(Type.Number({ description: "Initial confidence from 0.0 to 1.0." })),
	project: Type.Optional(Type.String({ description: "Project slug/name when scope is project." })),
	source_ref: Type.Optional(Type.String({ description: "Optional pointer to origin, not raw sensitive content." })),
	task_tags: Type.Optional(Type.Array(Type.String(), { description: "Useful task tags." })),
	links: Type.Optional(Type.Array(Type.String(), { description: "Related memory/entity ids or names." })),
});

const MemorySearchParams = Type.Object({
	query: Type.String({ description: "Search query." }),
	limit: Type.Optional(Type.Number({ description: "Maximum number of memories to return. Defaults to 5." })),
	scope: Type.Optional(Type.String({ enum: [...MEMORY_SCOPES], description: "Optional scope filter." })),
	project: Type.Optional(Type.String({ description: "Optional project filter for project-scoped memories." })),
});

let qmdCollectionReady: boolean | undefined;

function memoryRoot(): string {
	return process.env.PI_MEMORY_DIR ?? join(homedir(), ".pi", "memory");
}

function memoryDirs(root = memoryRoot()) {
	return {
		root,
		inbox: join(root, "inbox"),
		memories: join(root, "memories"),
		archive: join(root, "archive"),
		logs: join(root, "logs"),
		compiled: join(root, "compiled"),
	};
}

async function ensureMemoryStore(): Promise<void> {
	const dirs = memoryDirs();
	await Promise.all([mkdir(dirs.inbox, { recursive: true }), mkdir(dirs.memories, { recursive: true }), mkdir(dirs.archive, { recursive: true }), mkdir(dirs.logs, { recursive: true }), mkdir(dirs.compiled, { recursive: true })]);

	const agentBriefPath = join(dirs.compiled, "agent_brief.md");
	if (!existsSync(agentBriefPath)) {
		await writeFile(
			agentBriefPath,
			[
				"# Agent Brief",
				"",
				"Tiny startup-safe context for the Pi memory extension.",
				"",
				"- Memory uses Markdown as the canonical source of truth.",
				"- Saved memories start as candidates and must be promoted before auto-injection.",
				"- Retrieve broadly, inject conservatively.",
				"",
			].join("\n"),
			"utf8",
		);
	}

	const logPath = join(dirs.logs, "injection_decisions.jsonl");
	if (!existsSync(logPath)) {
		await writeFile(logPath, "", "utf8");
	}
}

function clampConfidence(value: number | undefined): number {
	if (typeof value !== "number" || Number.isNaN(value)) return 0.4;
	return Math.max(0, Math.min(1, value));
}

function createMemoryId(date = new Date()): string {
	const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${stamp}-${suffix}`;
}

function slugify(input: string): string {
	const slug = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug || "memory";
}

function formatFrontmatterValue(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(String(item))).join(", ")}]`;
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	if (value === undefined || value === null) return "";
	return JSON.stringify(String(value));
}

function formatMemoryMarkdown(frontmatter: MemoryFrontmatter, content: string): string {
	const fields: Array<keyof MemoryFrontmatter> = [
		"id",
		"type",
		"status",
		"bucket",
		"confidence",
		"scope",
		"project",
		"agent",
		"sensitivity",
		"durable",
		"source",
		"source_ref",
		"reason",
		"created_at",
		"task_tags",
		"links",
	];

	const yaml = fields
		.filter((field) => frontmatter[field] !== undefined && frontmatter[field] !== "")
		.map((field) => `${field}: ${formatFrontmatterValue(frontmatter[field])}`)
		.join("\n");

	return `---\n${yaml}\n---\n\n${content.trim()}\n`;
}

function parseFrontmatterValue(raw: string): unknown {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return trimmed.slice(1, -1).split(",").map((part) => part.trim()).filter(Boolean);
		}
	}
	try {
		return JSON.parse(trimmed);
	} catch {
		return trimmed;
	}
}

function parseMemoryMarkdown(markdown: string, filePath: string): MemoryDocument | null {
	if (!markdown.startsWith("---\n")) return null;
	const end = markdown.indexOf("\n---\n", 4);
	if (end === -1) return null;

	const rawFrontmatter = markdown.slice(4, end);
	const data: Record<string, unknown> = {};
	for (const line of rawFrontmatter.split("\n")) {
		const separator = line.indexOf(":");
		if (separator === -1) continue;
		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1);
		data[key] = parseFrontmatterValue(value);
	}

	if (typeof data.id !== "string") return null;

	return {
		frontmatter: {
			id: data.id,
			type: (data.type as MemoryType) ?? "unknown",
			status: (data.status as MemoryStatus) ?? "candidate",
			bucket: (data.bucket as MemoryBucket) ?? "active",
			confidence: typeof data.confidence === "number" ? data.confidence : 0.4,
			scope: (data.scope as MemoryScope) ?? "global",
			project: typeof data.project === "string" ? data.project : undefined,
			agent: typeof data.agent === "string" ? data.agent : undefined,
			sensitivity: (data.sensitivity as MemorySensitivity) ?? "internal",
			durable: typeof data.durable === "boolean" ? data.durable : false,
			source: typeof data.source === "string" ? data.source : "pi-session",
			source_ref: typeof data.source_ref === "string" ? data.source_ref : undefined,
			reason: typeof data.reason === "string" ? data.reason : "",
			created_at: typeof data.created_at === "string" ? data.created_at : new Date(0).toISOString(),
			task_tags: Array.isArray(data.task_tags) ? data.task_tags.map(String) : [],
			links: Array.isArray(data.links) ? data.links.map(String) : [],
		},
		content: markdown.slice(end + "\n---\n".length).trim(),
		path: filePath,
	};
}

async function readMemoryFile(filePath: string): Promise<MemoryDocument | null> {
	try {
		return parseMemoryMarkdown(await readFile(filePath, "utf8"), filePath);
	} catch {
		return null;
	}
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => join(dir, entry.name));
	} catch {
		return [];
	}
}

async function countMarkdownFiles(dir: string): Promise<number> {
	return (await listMarkdownFiles(dir)).length;
}

async function newestMarkdownFile(dir: string): Promise<string | undefined> {
	const files = await listMarkdownFiles(dir);
	let newest: { path: string; mtime: number } | undefined;
	for (const file of files) {
		try {
			const info = await stat(file);
			if (!newest || info.mtimeMs > newest.mtime) newest = { path: file, mtime: info.mtimeMs };
		} catch {
			// Ignore files that disappear while listing.
		}
	}
	return newest?.path;
}

async function readMemoryDocuments(dir: string): Promise<MemoryDocument[]> {
	const files = await listMarkdownFiles(dir);
	const documents = await Promise.all(files.map((file) => readMemoryFile(file)));
	return documents.filter((document): document is MemoryDocument => document !== null);
}

async function readAllMemoryDocuments(): Promise<MemoryDocument[]> {
	const dirs = memoryDirs();
	const [inbox, memories, archive] = await Promise.all([readMemoryDocuments(dirs.inbox), readMemoryDocuments(dirs.memories), readMemoryDocuments(dirs.archive)]);
	return [...inbox, ...memories, ...archive];
}

async function writeCandidateMemory(params: {
	content: string;
	type?: MemoryType;
	reason: string;
	scope?: MemoryScope;
	sensitivity?: MemorySensitivity;
	confidence?: number;
	project?: string;
	source?: string;
	source_ref?: string;
	task_tags?: string[];
	links?: string[];
}): Promise<{ id: string; path: string; frontmatter: MemoryFrontmatter }> {
	const sensitivity = params.sensitivity ?? "internal";
	if (sensitivity === "secret") {
		throw new Error("memory_save rejected sensitivity: secret. Secrets must not be stored or indexed.");
	}

	const id = createMemoryId();
	const frontmatter: MemoryFrontmatter = {
		id,
		type: params.type ?? "unknown",
		status: "candidate",
		bucket: "active",
		confidence: clampConfidence(params.confidence),
		scope: params.scope ?? "global",
		project: params.project,
		agent: "pi",
		sensitivity,
		durable: true,
		source: params.source ?? "pi-session",
		source_ref: params.source_ref,
		reason: params.reason,
		created_at: new Date().toISOString(),
		task_tags: params.task_tags ?? [],
		links: params.links ?? [],
	};

	const filePath = join(memoryDirs().inbox, `${id}-${slugify(params.content)}.md`);
	await writeFile(filePath, formatMemoryMarkdown(frontmatter, params.content), "utf8");
	return { id, path: filePath, frontmatter };
}

function sessionRoot(): string {
	return process.env.PI_SESSIONS_DIR ?? join(homedir(), ".pi", "agent", "sessions");
}

async function listJsonlFilesRecursive(dir: string): Promise<string[]> {
	let results: string[] = [];
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const entryPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				results = results.concat(await listJsonlFilesRecursive(entryPath));
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				results.push(entryPath);
			}
		}
	} catch {
		return [];
	}
	return results;
}

async function newestSessionFiles(options: { limit?: number; since?: string; latest?: boolean } = {}): Promise<string[]> {
	const requestedLimit = options.latest ? 1 : options.limit ?? DEFAULT_SESSION_DISTILL_LIMIT;
	const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(50, Math.floor(requestedLimit))) : DEFAULT_SESSION_DISTILL_LIMIT;
	const parsedSince = options.since ? Date.parse(options.since) : 0;
	const sinceMs = Number.isNaN(parsedSince) ? 0 : parsedSince;
	const files = await listJsonlFilesRecursive(sessionRoot());
	const withStats: Array<{ path: string; mtime: number }> = [];
	for (const file of files) {
		try {
			const info = await stat(file);
			if (!sinceMs || info.mtimeMs >= sinceMs) withStats.push({ path: file, mtime: info.mtimeMs });
		} catch {
			// Ignore files that disappear while listing.
		}
	}
	return withStats.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((entry) => entry.path);
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const typed = part as { type?: string; text?: string };
			if (typed.type === "text" && typeof typed.text === "string") return typed.text;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

async function readSessionTranscript(filePath: string): Promise<SessionTranscript | null> {
	try {
		const raw = await readFile(filePath, "utf8");
		const transcript: SessionTranscript = { path: filePath, messages: [] };
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}

			if (event.type === "session") {
				transcript.sessionId = typeof event.id === "string" ? event.id : transcript.sessionId;
				transcript.cwd = typeof event.cwd === "string" ? event.cwd : transcript.cwd;
				transcript.timestamp = typeof event.timestamp === "string" ? event.timestamp : transcript.timestamp;
				continue;
			}

			if (event.type !== "message" || !event.message || typeof event.message.role !== "string") continue;
			const text = contentText(event.message.content).trim();
			if (!text) continue;
			transcript.messages.push({
				id: typeof event.id === "string" ? event.id : `${basename(filePath)}:${transcript.messages.length}`,
				role: event.message.role,
				text,
				timestamp: typeof event.timestamp === "string" ? event.timestamp : undefined,
			});
		}
		return transcript;
	} catch {
		return null;
	}
}

function splitCandidateSentences(text: string): string[] {
	return text
		.replace(/\s+/g, " ")
		.split(/(?<=[.!?])\s+|\n+/)
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence.length >= 18 && sentence.length <= 280);
}

function classifyDurableSentence(sentence: string): { type: MemoryType; confidence: number; reason: string } | null {
	const normalized = normalizeText(sentence);
	if (/\b(api key|password|token|secret|private key|credential)\b/i.test(sentence)) return null;
	if (/\b(i|edgaras)\s+(prefer|prefers|like|likes|want|wants)\b/.test(normalized) || /\bpreference\b/.test(normalized)) {
		return { type: "preference", confidence: 0.7, reason: "session distillation found an explicit preference" };
	}
	if (/\b(we|i|edgaras)\s+(decided|chose|agreed)\b/.test(normalized) || /\bdecision\b/.test(normalized)) {
		return { type: "decision", confidence: 0.72, reason: "session distillation found an explicit decision" };
	}
	if (/\b(always|never|from now on|do not|don't|must|prefer using|use)\b/.test(normalized) && /\b(for|when|in|with)\b/.test(normalized)) {
		return { type: "procedure", confidence: 0.62, reason: "session distillation found reusable guidance" };
	}
	if (/\b(project|client|app|extension|repo|site)\b/.test(normalized) && /\b(is|uses|has|runs|builds|stores|lives|located)\b/.test(normalized)) {
		return { type: "project_note", confidence: 0.58, reason: "session distillation found a project fact" };
	}
	if (/\b(learned|lesson|avoid|because)\b/.test(normalized) && /\b(should|must|need|works|fails)\b/.test(normalized)) {
		return { type: "lesson", confidence: 0.6, reason: "session distillation found a reusable lesson" };
	}
	return null;
}

function cleanDistilledContent(sentence: string): string {
	return sentence
		.replace(/^remember that\s+/i, "")
		.replace(/^note that\s+/i, "")
		.replace(/^keep in mind that\s+/i, "")
		.trim();
}

function inferScopeAndProject(transcript: SessionTranscript, sentence: string): { scope: MemoryScope; project?: string } {
	const cwdProject = transcript.cwd ? inferProjectFromCwd(transcript.cwd) : undefined;
	if (/\bfor this project\b|\bin this project\b|\bthis repo\b|\bthis app\b/i.test(sentence) && cwdProject) {
		return { scope: "project", project: cwdProject };
	}
	if (/\b(edgaras|i prefer|my preference|personal)\b/i.test(sentence)) return { scope: "user" };
	return cwdProject ? { scope: "project", project: cwdProject } : { scope: "global" };
}

function distillTranscript(transcript: SessionTranscript): DistilledMemoryCandidate[] {
	const candidates: DistilledMemoryCandidate[] = [];
	const seen = new Set<string>();
	for (const message of transcript.messages) {
		if (message.role !== "user") continue;
		const sentences = splitCandidateSentences(message.text);
		for (let index = 0; index < sentences.length; index++) {
			const classification = classifyDurableSentence(sentences[index]);
			if (!classification) continue;
			const content = cleanDistilledContent(sentences[index]);
			const key = normalizeText(content);
			if (seen.has(key)) continue;
			seen.add(key);
			const scope = inferScopeAndProject(transcript, content);
			const sourceRef = `session:${basename(transcript.path)}#${message.id}:${index}`;
			candidates.push({
				content,
				type: classification.type,
				reason: classification.reason,
				scope: scope.scope,
				project: scope.project,
				confidence: classification.confidence,
				sensitivity: "internal",
				source_ref: sourceRef,
				task_tags: ["session-distillation"],
				links: [],
			});
			if (candidates.length >= MAX_DISTILLED_CANDIDATES_PER_SESSION) return candidates;
		}
	}
	return candidates;
}

async function sourceRefExists(sourceRef: string): Promise<boolean> {
	const docs = await readAllMemoryDocuments();
	return docs.some((document) => document.frontmatter.source_ref === sourceRef);
}

function candidateKey(content: string): string {
	return normalizeText(content).replace(/\b(please|remember|save|this|that|to|memory)\b/g, " ").replace(/\s+/g, " ").trim();
}

async function contentAlreadyExists(content: string): Promise<boolean> {
	const key = candidateKey(content);
	if (!key) return false;
	const docs = await readAllMemoryDocuments();
	return docs.some((document) => candidateKey(document.content) === key);
}

function evaluateDistilledCandidate(candidate: DistilledMemoryCandidate): { accept: true; reason: string } | { accept: false; reason: string } {
	const content = candidate.content.trim();
	const normalized = normalizeText(content);
	const words = normalized.split(/\s+/).filter(Boolean);

	if (content.includes("?")) return { accept: false, reason: "question/task request" };
	if (words.length < 4) return { accept: false, reason: "too short to be useful" };
	if (words.length > 36) return { accept: false, reason: "not atomic enough" };
	if (/\b(session distillation complete|sessions scanned|candidates found|candidates saved|duplicates skipped|saved users|latest memory injection decision|memory root|search backend|backend qmd|warning|error)\b/.test(normalized)) {
		return { accept: false, reason: "debug or command output" };
	}
	if (/\b(how should|what should|can you|please read|tell me|here is what|it tried|however i want|i added)\b/.test(normalized)) {
		return { accept: false, reason: "task chatter" };
	}
	if (/\b(tool result|path users|node modules|typescript|jsonl|stdout|stderr|stack trace)\b/.test(normalized)) {
		return { accept: false, reason: "tool/log artifact" };
	}
	if (/\b(api key|password|token|secret|private key|credential)\b/.test(normalized)) {
		return { accept: false, reason: "possible secret" };
	}

	const explicitRemember = /\b(remember|save this|save to memory|keep in mind)\b/.test(normalized);
	const strongPreference = candidate.type === "preference" && /\b(edgaras prefers|i prefer|my preference|i like|i want)\b/.test(normalized);
	const strongDecision = candidate.type === "decision" && /\b(decided|chose|agreed)\b/.test(normalized);
	const strongProcedure = candidate.type === "procedure" && /\b(always|never|from now on|do not|don't|must|use)\b/.test(normalized);
	const strongProjectFact = candidate.type === "project_note" && /\b(project|app|extension|repo|site|client)\b/.test(normalized);
	const strongLesson = candidate.type === "lesson" && /\b(learned|lesson|avoid|because)\b/.test(normalized);

	if (!(explicitRemember || strongPreference || strongDecision || strongProcedure || strongProjectFact || strongLesson)) {
		return { accept: false, reason: "not clearly durable" };
	}

	return { accept: true, reason: explicitRemember ? "explicit remember/save signal" : `clear ${candidate.type}` };
}

async function distillSessions(options: { limit?: number; since?: string; latest?: boolean; apply?: boolean } = {}): Promise<DistillationResult> {
	await ensureMemoryStore();
	const sessionFiles = await newestSessionFiles(options);
	const result: DistillationResult = {
		dryRun: !options.apply,
		sessionsScanned: 0,
		candidatesFound: 0,
		candidatesAccepted: 0,
		candidatesRejected: 0,
		candidatesSaved: 0,
		duplicatesSkipped: 0,
		accepted: [],
		rejected: [],
		paths: [],
	};
	const seenContent = new Set<string>();
	for (const sessionFile of sessionFiles) {
		const transcript = await readSessionTranscript(sessionFile);
		if (!transcript) continue;
		result.sessionsScanned++;
		const candidates = distillTranscript(transcript);
		result.candidatesFound += candidates.length;
		for (const candidate of candidates) {
			const key = candidateKey(candidate.content);
			if (seenContent.has(key)) {
				result.duplicatesSkipped++;
				continue;
			}
			seenContent.add(key);

			const evaluation = evaluateDistilledCandidate(candidate);
			if (!evaluation.accept) {
				result.candidatesRejected++;
				result.rejected.push({ content: candidate.content, reason: evaluation.reason });
				continue;
			}

			if (await sourceRefExists(candidate.source_ref) || await contentAlreadyExists(candidate.content)) {
				result.duplicatesSkipped++;
				continue;
			}

			const accepted = { ...candidate, evaluationReason: evaluation.reason };
			result.candidatesAccepted++;
			result.accepted.push(accepted);

			if (!options.apply) continue;
			const saved = await writeCandidateMemory({ ...candidate, reason: `${candidate.reason}; ${evaluation.reason}`, source: "pi-session-distill" });
			result.candidatesSaved++;
			result.paths.push(saved.path);
		}
	}
	return result;
}

function parseDistillArgs(rest: string): { limit?: number; since?: string; latest?: boolean; apply?: boolean } {
	const parts = rest.split(/\s+/).filter(Boolean);
	const options: { limit?: number; since?: string; latest?: boolean; apply?: boolean } = {};
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index];
		if (part === "--latest") options.latest = true;
		else if (part === "--apply") options.apply = true;
		else if (part === "--dry-run") options.apply = false;
		else if (part === "--limit" && parts[index + 1]) options.limit = Number(parts[++index]);
		else if (part.startsWith("--limit=")) options.limit = Number(part.slice("--limit=".length));
		else if (part === "--since" && parts[index + 1]) options.since = parts[++index];
		else if (part.startsWith("--since=")) options.since = part.slice("--since=".length);
	}
	return options;
}

function memoryCreatedAt(document: MemoryDocument): number {
	const timestamp = Date.parse(document.frontmatter.created_at);
	return Number.isNaN(timestamp) ? 0 : timestamp;
}

function sortMemoriesNewestFirst(documents: MemoryDocument[]): MemoryDocument[] {
	return [...documents].sort((a, b) => memoryCreatedAt(b) - memoryCreatedAt(a) || b.frontmatter.id.localeCompare(a.frontmatter.id));
}

function formatCompactMemory(document: MemoryDocument): string {
	const { frontmatter } = document;
	const project = frontmatter.project ? `/${frontmatter.project}` : "";
	const firstLine = document.content.replace(/\s+/g, " ").slice(0, 110);
	return `${frontmatter.status.padEnd(9)} ${frontmatter.id} ${frontmatter.type} ${frontmatter.scope}${project} — ${firstLine}`;
}

function normalizeText(input: string): string {
	return input.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokenize(input: string): string[] {
	const stopwords = new Set(["the", "and", "for", "with", "that", "this", "what", "how", "should", "could", "would", "you", "are", "about"]);
	return normalizeText(input)
		.split(/\s+/)
		.filter((token) => token.length > 1 && !stopwords.has(token));
}

function isSearchEligible(document: MemoryDocument, scope?: string, project?: string): boolean {
	const { frontmatter } = document;
	if (frontmatter.status !== "active") return false;
	if (frontmatter.bucket !== "active" && frontmatter.bucket !== "pinned") return false;
	if (frontmatter.sensitivity !== "public" && frontmatter.sensitivity !== "internal") return false;
	if (scope && frontmatter.scope !== scope && frontmatter.scope !== "global") return false;
	if (project && frontmatter.scope === "project" && frontmatter.project !== project) return false;
	return true;
}

function scoreMemory(query: string, document: MemoryDocument): { score: number; reasons: string[] } {
	const queryText = normalizeText(query);
	const searchable = normalizeText([
		document.content,
		document.frontmatter.reason,
		document.frontmatter.type,
		document.frontmatter.scope,
		document.frontmatter.project ?? "",
		document.frontmatter.task_tags.join(" "),
		document.frontmatter.links.join(" "),
	].join(" "));
	const queryTokens = new Set(tokenize(query));
	let score = 0;
	const reasons: string[] = [];

	if (queryText.length > 0 && searchable.includes(queryText)) {
		score += 5;
		reasons.push("exact phrase");
	}

	let tokenMatches = 0;
	for (const token of queryTokens) {
		if (searchable.includes(token)) tokenMatches++;
	}
	if (tokenMatches > 0) {
		score += tokenMatches * 2;
		reasons.push(`${tokenMatches} token match${tokenMatches === 1 ? "" : "es"}`);
	}

	if (score > 0 && document.frontmatter.confidence > 0.7) {
		score += 1;
		reasons.push("high confidence");
	}

	return { score, reasons };
}

function makeSnippet(content: string, query: string): string {
	const normalizedContent = normalizeText(content);
	const firstToken = tokenize(query).find((token) => normalizedContent.includes(token));
	const plain = content.replace(/\s+/g, " ").trim();
	if (!firstToken) return plain.slice(0, 220);
	const index = normalizedContent.indexOf(firstToken);
	const start = Math.max(0, index - 80);
	const snippet = plain.slice(start, start + 220);
	return `${start > 0 ? "…" : ""}${snippet}${start + 220 < plain.length ? "…" : ""}`;
}

async function searchMemories(query: string, options: { limit?: number; scope?: string; project?: string } = {}): Promise<MemorySearchResult[]> {
	const dirs = memoryDirs();
	const documents = await readMemoryDocuments(dirs.memories);
	const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 5)));

	return documents
		.filter((document) => isSearchEligible(document, options.scope, options.project))
		.map((document) => {
			const scored = scoreMemory(query, document);
			return {
				id: document.frontmatter.id,
				path: document.path,
				type: document.frontmatter.type,
				scope: document.frontmatter.scope,
				project: document.frontmatter.project,
				score: scored.score,
				reasons: scored.reasons,
				snippet: makeSnippet(document.content, query),
			};
		})
		.filter((result) => result.score > 0)
		.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
		.slice(0, limit);
}

async function getSearchBackend(pi: ExtensionAPI): Promise<SearchBackend> {
	try {
		const result = await pi.exec("qmd", ["collection", "list"], { timeout: 5000 });
		if (result.code === 0 && result.stdout.includes(`${QMD_MEMORY_COLLECTION} (`)) return "qmd";
	} catch {
		// Fall back to simple search when qmd is unavailable or not configured.
	}
	return "simple";
}

async function ensureQmdCollection(pi: ExtensionAPI): Promise<boolean> {
	if (qmdCollectionReady !== undefined) return qmdCollectionReady;
	try {
		const list = await pi.exec("qmd", ["collection", "list"], { timeout: 5000 });
		if (list.code === 0 && list.stdout.includes(`${QMD_MEMORY_COLLECTION} (`)) {
			qmdCollectionReady = true;
			return true;
		}
		const add = await pi.exec("qmd", ["collection", "add", memoryDirs().memories, "--name", QMD_MEMORY_COLLECTION, "--mask", "**/*.md"], { timeout: 30000 });
		qmdCollectionReady = add.code === 0;
		return qmdCollectionReady;
	} catch {
		qmdCollectionReady = false;
		return false;
	}
}

function qmdFileToLocalPath(file: string): string | undefined {
	const prefix = `qmd://${QMD_MEMORY_COLLECTION}/`;
	if (!file.startsWith(prefix)) return undefined;
	return join(memoryDirs().memories, file.slice(prefix.length));
}

function cleanQmdSnippet(snippet: string): string {
	return snippet
		.replace(/^@@[^\n]*\n+/g, "")
		.replace(/\n+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 260);
}

async function searchMemoriesWithQmd(pi: ExtensionAPI, query: string, options: { limit?: number; scope?: string; project?: string } = {}): Promise<MemorySearchResult[]> {
	const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 5)));
	const result = await pi.exec("qmd", ["search", query, "-c", QMD_MEMORY_COLLECTION, "--json", "-n", String(limit * 2)], { timeout: 15000 });
	if (result.code !== 0) return [];

	let rawResults: Array<{ score?: number; file?: string; snippet?: string }> = [];
	try {
		rawResults = JSON.parse(result.stdout || "[]");
	} catch {
		return [];
	}

	const results: MemorySearchResult[] = [];
	for (const raw of rawResults) {
		if (!raw.file) continue;
		const localPath = qmdFileToLocalPath(raw.file);
		if (!localPath) continue;
		const document = await readMemoryFile(localPath);
		if (!document || !isSearchEligible(document, options.scope, options.project)) continue;

		const normalizedScore = Math.max(1, Math.round((raw.score ?? 0) * 20));
		results.push({
			id: document.frontmatter.id,
			path: document.path,
			type: document.frontmatter.type,
			scope: document.frontmatter.scope,
			project: document.frontmatter.project,
			score: normalizedScore,
			reasons: [`qmd bm25 ${raw.score?.toFixed(3) ?? "n/a"}`],
			snippet: raw.snippet ? cleanQmdSnippet(raw.snippet) : makeSnippet(document.content, query),
		});
	}

	return results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

async function searchMemoriesBestEffort(pi: ExtensionAPI, query: string, options: { limit?: number; scope?: string; project?: string } = {}): Promise<{ backend: SearchBackend; results: MemorySearchResult[] }> {
	const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 5)));
	const simpleResults = await searchMemories(query, { ...options, limit });
	if (await ensureQmdCollection(pi)) {
		const qmdResults = await searchMemoriesWithQmd(pi, query, { ...options, limit });
		const merged = new Map<string, MemorySearchResult>();
		for (const result of [...simpleResults, ...qmdResults]) {
			const existing = merged.get(result.id);
			if (!existing || result.score > existing.score) {
				merged.set(result.id, existing ? { ...result, reasons: [...new Set([...result.reasons, ...existing.reasons])] } : result);
			} else {
				existing.reasons = [...new Set([...existing.reasons, ...result.reasons])];
			}
		}
		return { backend: "qmd", results: [...merged.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit) };
	}
	return { backend: "simple", results: simpleResults };
}

async function findInboxMemoryById(idOrPrefix: string): Promise<MemoryDocument[]> {
	const query = idOrPrefix.trim();
	if (!query) return [];
	const docs = await readMemoryDocuments(memoryDirs().inbox);
	return docs.filter((document) => document.frontmatter.id === query || document.frontmatter.id.startsWith(query));
}

async function findMemoryById(idOrPrefix: string): Promise<MemoryDocument[]> {
	const query = idOrPrefix.trim();
	if (!query) return [];
	const docs = await readAllMemoryDocuments();
	return docs.filter((document) => document.frontmatter.id === query || document.frontmatter.id.startsWith(query));
}

async function resolveOneMemory(idOrPrefix: string): Promise<{ memory?: MemoryDocument; error?: string }> {
	const query = idOrPrefix.trim();
	if (!query) return { error: "missing id" };
	const matches = await findMemoryById(query);
	if (matches.length === 0) return { error: `No memory found for: ${query}` };
	if (matches.length > 1) return { error: `Multiple memories match ${query}:\n${matches.map((memory) => memory.frontmatter.id).join("\n")}` };
	return { memory: matches[0] };
}

function formatDetailedMemory(document: MemoryDocument): string {
	const { frontmatter } = document;
	return [
		`Memory ${frontmatter.id}`,
		`Status: ${frontmatter.status}`,
		`Type: ${frontmatter.type}`,
		`Scope: ${frontmatter.scope}${frontmatter.project ? `/${frontmatter.project}` : ""}`,
		`Sensitivity: ${frontmatter.sensitivity}`,
		`Confidence: ${frontmatter.confidence}`,
		`Reason: ${frontmatter.reason || "none"}`,
		`Tags: ${frontmatter.task_tags.length ? frontmatter.task_tags.join(", ") : "none"}`,
		`Path: ${document.path}`,
		"",
		document.content,
	].join("\n");
}

async function promoteInboxMemory(memory: MemoryDocument): Promise<string> {
	const promoted: MemoryFrontmatter = {
		...memory.frontmatter,
		status: "active",
		bucket: memory.frontmatter.bucket === "archived" ? "active" : memory.frontmatter.bucket,
	};
	const targetPath = join(memoryDirs().memories, basename(memory.path));
	await writeFile(targetPath, formatMemoryMarkdown(promoted, memory.content), "utf8");
	await rm(memory.path, { force: true });
	return targetPath;
}

async function rejectInboxMemory(memory: MemoryDocument): Promise<string> {
	const rejected: MemoryFrontmatter = {
		...memory.frontmatter,
		status: "rejected",
		bucket: "archived",
	};
	const targetPath = join(memoryDirs().archive, basename(memory.path));
	await writeFile(targetPath, formatMemoryMarkdown(rejected, memory.content), "utf8");
	await rm(memory.path, { force: true });
	return targetPath;
}

function renderReviewLines(memory: MemoryDocument, index: number, total: number, theme: any, width: number): string[] {
	const { frontmatter } = memory;
	const content = memory.content.replace(/\s+/g, " ");
	const maxContent = Math.max(80, width - 4);
	return [
		"",
		theme.fg("accent", theme.bold(` Memory Review ${index + 1}/${total} `)),
		"",
		`${theme.fg("muted", "ID:")} ${frontmatter.id}`,
		`${theme.fg("muted", "Type:")} ${frontmatter.type}    ${theme.fg("muted", "Scope:")} ${frontmatter.scope}${frontmatter.project ? `/${frontmatter.project}` : ""}`,
		`${theme.fg("muted", "Confidence:")} ${frontmatter.confidence}    ${theme.fg("muted", "Sensitivity:")} ${frontmatter.sensitivity}`,
		`${theme.fg("muted", "Reason:")} ${frontmatter.reason || "none"}`,
		`${theme.fg("muted", "Tags:")} ${frontmatter.task_tags.length ? frontmatter.task_tags.join(", ") : "none"}`,
		"",
		content.length > maxContent ? `${content.slice(0, maxContent - 1)}…` : content,
		"",
		theme.fg("dim", "p promote • r reject • e edit • n next • q/esc quit"),
		"",
	];
}

function inferProjectFromCwd(cwd: string): string | undefined {
	const name = basename(cwd).trim();
	return name || undefined;
}

function decideInjection(query: string, cwd: string, results: MemorySearchResult[]): InjectionDecision {
	const top = results[0];
	const project = inferProjectFromCwd(cwd);
	const timestamp = new Date().toISOString();
	const topScore = top?.score ?? 0;
	const rejectedTopIds = results.slice(0, 5).map((result) => result.id);

	if (!top) {
		return {
			timestamp,
			query,
			cwd,
			project,
			inject: false,
			reason: "no active matching memories",
			confidence: 0,
			topScore: 0,
			selectedMemoryIds: [],
			rejectedTopIds: [],
		};
	}

	if (topScore < 7) {
		return {
			timestamp,
			query,
			cwd,
			project,
			inject: false,
			reason: `top score ${topScore} below conservative injection threshold 7`,
			confidence: Math.min(0.6, topScore / 10),
			topScore,
			selectedMemoryIds: [],
			rejectedTopIds,
		};
	}

	const selected = results.filter((result) => result.score >= 7).slice(0, 2);
	return {
		timestamp,
		query,
		cwd,
		project,
		inject: true,
		reason: `top score ${topScore} met conservative threshold`,
		confidence: Math.min(0.95, topScore / 10),
		topScore,
		selectedMemoryIds: selected.map((result) => result.id),
		rejectedTopIds: results.filter((result) => !selected.some((selectedResult) => selectedResult.id === result.id)).slice(0, 5).map((result) => result.id),
	};
}

async function appendInjectionDecision(decision: InjectionDecision): Promise<void> {
	await ensureMemoryStore();
	await appendFile(join(memoryDirs().logs, "injection_decisions.jsonl"), `${JSON.stringify(decision)}\n`, "utf8");
}

async function readLatestInjectionDecision(): Promise<InjectionDecision | null> {
	try {
		const log = await readFile(join(memoryDirs().logs, "injection_decisions.jsonl"), "utf8");
		const line = log.trim().split("\n").filter(Boolean).at(-1);
		if (!line) return null;
		return JSON.parse(line) as InjectionDecision;
	} catch {
		return null;
	}
}

function buildInjectedMemoryBlock(results: MemorySearchResult[], selectedMemoryIds: string[]): string {
	const selected = results.filter((result) => selectedMemoryIds.includes(result.id));
	if (selected.length === 0) return "";

	return [
		"## Relevant Memory",
		"The following promoted memories may be relevant for this turn. Use them only if they help answer the user's request.",
		"",
		...selected.flatMap((result) => [
			`- ${result.id} (${result.type}, ${result.scope}${result.project ? `/${result.project}` : ""}, score ${result.score})`,
			`  ${result.snippet}`,
			`  Source: ${result.path}`,
		]),
	].join("\n");
}

const MEMORY_SUBCOMMANDS: CompletionItem[] = [
	{ value: "status", label: "status", description: "Show store counts" },
	{ value: "list", label: "list", description: "List memories" },
	{ value: "inbox", label: "inbox", description: "List candidate memories" },
	{ value: "active", label: "active", description: "List active memories" },
	{ value: "archive", label: "archive", description: "List rejected/archived memories" },
	{ value: "show", label: "show", description: "Inspect one memory by id" },
	{ value: "edit", label: "edit", description: "Edit one memory Markdown note" },
	{ value: "promote", label: "promote", description: "Promote inbox candidate to active" },
	{ value: "reject", label: "reject", description: "Reject inbox candidate to archive" },
	{ value: "review", label: "review", description: "Review inbox candidates interactively" },
	{ value: "distill-sessions", label: "distill-sessions", description: "Extract candidate memories from recent Pi session logs" },
	{ value: "debug", label: "debug", description: "Show latest injection decision" },
	{ value: "qmd-update", label: "qmd-update", description: "Create/update QMD memory collection" },
	{ value: "qmd-embed", label: "qmd-embed", description: "Generate QMD vector embeddings manually" },
	{ value: "help", label: "help", description: "Show memory command help" },
];

const MEMORY_LIST_MODES: CompletionItem[] = [
	{ value: "all", label: "all", description: "Inbox, active, and archive" },
	{ value: "inbox", label: "inbox", description: "Candidate memories" },
	{ value: "active", label: "active", description: "Promoted active memories" },
	{ value: "archive", label: "archive", description: "Rejected/archived memories" },
];

function filterCompletions(items: CompletionItem[], prefix: string): CompletionItem[] | null {
	const normalizedPrefix = prefix.trim().toLowerCase();
	const matches = normalizedPrefix
		? items.filter((item) => item.value.toLowerCase().startsWith(normalizedPrefix) || item.label?.toLowerCase().startsWith(normalizedPrefix))
		: items;
	return matches.length > 0 ? matches : null;
}

function readMemoryDocumentsSync(dir: string): MemoryDocument[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
			.map((entry) => join(dir, entry.name))
			.map((file) => parseMemoryMarkdown(readFileSync(file, "utf8"), file))
			.filter((document): document is MemoryDocument => document !== null);
	} catch {
		return [];
	}
}

function memoryIdCompletions(kind: "all" | "inbox", prefix: string): CompletionItem[] | null {
	const dirs = memoryDirs();
	const documents = kind === "inbox"
		? readMemoryDocumentsSync(dirs.inbox)
		: [...readMemoryDocumentsSync(dirs.inbox), ...readMemoryDocumentsSync(dirs.memories), ...readMemoryDocumentsSync(dirs.archive)];
	const normalizedPrefix = prefix.trim().toLowerCase();
	const items = sortMemoriesNewestFirst(documents)
		.filter((document) => !normalizedPrefix || document.frontmatter.id.toLowerCase().startsWith(normalizedPrefix))
		.slice(0, 20)
		.map((document) => ({
			value: document.frontmatter.id,
			label: document.frontmatter.id,
			description: `${document.frontmatter.status} ${document.frontmatter.type} — ${document.content.replace(/\s+/g, " ").slice(0, 72)}`,
		}));
	return items.length > 0 ? items : null;
}

function memoryArgumentCompletions(prefix: string): CompletionItem[] | null {
	const hasTrailingSpace = /\s$/.test(prefix);
	const parts = prefix.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return MEMORY_SUBCOMMANDS;

	if (parts.length === 1 && !hasTrailingSpace) {
		return filterCompletions(MEMORY_SUBCOMMANDS, parts[0]);
	}

	const subcommand = parts[0]?.toLowerCase();
	const current = hasTrailingSpace ? "" : parts.at(-1) ?? "";

	if (subcommand === "list") return filterCompletions(MEMORY_LIST_MODES, current);
	if (subcommand === "show" || subcommand === "edit") return memoryIdCompletions("all", current);
	if (subcommand === "promote" || subcommand === "reject") return memoryIdCompletions("inbox", current);

	return null;
}

export default function memoryExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		await ensureMemoryStore();
		ctx.ui.setStatus("memory", "memory: ready");
	});

	pi.on("before_agent_start", async (event, ctx) => {
		await ensureMemoryStore();
		const search = await searchMemoriesBestEffort(pi, event.prompt, { limit: 5 });
		const results = search.results;
		const decision = decideInjection(event.prompt, ctx.cwd, results);
		decision.reason = `${decision.reason}; backend=${search.backend}`;
		await appendInjectionDecision(decision);

		if (!decision.inject) {
			ctx.ui.setStatus("memory", decision.topScore > 0 ? `memory: no inject ${search.backend} (${decision.topScore})` : `memory: no match ${search.backend}`);
			return;
		}

		const memoryBlock = buildInjectedMemoryBlock(results, decision.selectedMemoryIds);
		if (!memoryBlock) {
			ctx.ui.setStatus("memory", "memory: no inject");
			return;
		}

		ctx.ui.setStatus("memory", `memory: injected ${decision.selectedMemoryIds.length} ${search.backend} (${decision.topScore})`);
		return {
			systemPrompt: `${event.systemPrompt}\n\n${memoryBlock}`,
		};
	});

	pi.registerCommand("memory", {
		description: "Manage Pi memory: /memory status|list|show|edit|promote|reject|review|distill-sessions|debug|qmd-update|qmd-embed",
		getArgumentCompletions: memoryArgumentCompletions,
		handler: async (args, ctx) => {
			await ensureMemoryStore();
			const trimmed = args.trim();
			const [rawSubcommand = "help", ...restParts] = trimmed ? trimmed.split(/\s+/) : [];
			const subcommand = rawSubcommand.toLowerCase();
			const rest = restParts.join(" ").trim();

			if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
				ctx.ui.notify(
					[
						"Memory commands:",
						"/memory status — show store counts",
						"/memory list [all|inbox|active|archive] — list memories",
						"/memory show <id-prefix> — inspect one memory",
						"/memory edit <id-prefix> — edit one memory Markdown note",
						"/memory promote <id-prefix> — promote inbox candidate to active",
						"/memory reject <id-prefix> — reject inbox candidate to archive",
						"/memory review — review inbox candidates interactively",
						"/memory distill-sessions [--latest|--limit N|--since ISO] [--apply] — dry-run by default; --apply saves accepted candidates",
						"/memory debug — show latest injection decision",
						"/memory qmd-update — create/update QMD memory collection",
						"/memory qmd-embed — generate QMD vector embeddings manually",
					].join("\n"),
					"info",
				);
				return;
			}

			if (subcommand === "status") {
				const dirs = memoryDirs();
				const inboxCount = await countMarkdownFiles(dirs.inbox);
				const memoryCount = await countMarkdownFiles(dirs.memories);
				const archiveCount = await countMarkdownFiles(dirs.archive);
				const latestInbox = await newestMarkdownFile(dirs.inbox);
				const backend = await getSearchBackend(pi);
				ctx.ui.notify(
					[
						`Memory root: ${dirs.root}`,
						`Inbox candidates: ${inboxCount}`,
						`Active memories: ${memoryCount}`,
						`Archived/rejected: ${archiveCount}`,
						`Search backend: ${backend}`,
						latestInbox ? `Latest inbox: ${basename(latestInbox)}` : "Latest inbox: none",
					].join("\n"),
					"info",
				);
				return;
			}

			if (subcommand === "qmd-embed") {
				qmdCollectionReady = undefined;
				const created = await ensureQmdCollection(pi);
				if (!created) {
					ctx.ui.notify("QMD is unavailable or collection setup failed. Simple search fallback remains active.", "warning");
					return;
				}

				const embed = await pi.exec("qmd", ["embed"], { timeout: 600000 });
				ctx.ui.notify(
					[
						`QMD embeddings for memory index`,
						`Result: ${embed.code === 0 ? "ok" : `failed (${embed.code})`}`,
						(embed.stdout || embed.stderr).split("\n").slice(-12).join("\n"),
					].filter(Boolean).join("\n"),
					embed.code === 0 ? "info" : "warning",
				);
				return;
			}

			if (subcommand === "qmd-update") {
				qmdCollectionReady = undefined;
				const created = await ensureQmdCollection(pi);
				if (!created) {
					ctx.ui.notify("QMD is unavailable or collection setup failed. Simple search fallback remains active.", "warning");
					return;
				}

				const update = await pi.exec("qmd", ["update"], { timeout: 120000 });
				const backend = await getSearchBackend(pi);
				ctx.ui.notify(
					[
						`QMD memory collection: ${QMD_MEMORY_COLLECTION}`,
						`Backend: ${backend}`,
						`Update: ${update.code === 0 ? "ok" : `failed (${update.code})`}`,
						(update.stdout || update.stderr).split("\n").slice(-8).join("\n"),
					].filter(Boolean).join("\n"),
					update.code === 0 ? "info" : "warning",
				);
				return;
			}

			if (subcommand === "distill-sessions") {
				const result = await distillSessions(parseDistillArgs(rest));
				ctx.ui.notify(
					[
						result.dryRun ? "Session distillation dry run — no files saved. Re-run with --apply to save accepted candidates." : "Session distillation complete",
						`Session root: ${sessionRoot()}`,
						`Sessions scanned: ${result.sessionsScanned}`,
						`Candidates found: ${result.candidatesFound}`,
						`Accepted after quality gate: ${result.candidatesAccepted}`,
						`Rejected by quality gate: ${result.candidatesRejected}`,
						`Duplicates skipped: ${result.duplicatesSkipped}`,
						`Candidates saved: ${result.candidatesSaved}`,
						result.accepted.length ? "" : "Accepted: none",
						...result.accepted.slice(0, 8).map((candidate) => `Accept ${candidate.type}: ${candidate.content} (${candidate.evaluationReason})`),
						result.accepted.length > 8 ? `...and ${result.accepted.length - 8} more accepted` : "",
						result.rejected.length ? "" : "Rejected: none",
						...result.rejected.slice(0, 8).map((candidate) => `Reject: ${candidate.content.slice(0, 120)} (${candidate.reason})`),
						result.rejected.length > 8 ? `...and ${result.rejected.length - 8} more rejected` : "",
						...result.paths.slice(0, 8).map((path) => `Saved: ${path}`),
						result.paths.length > 8 ? `...and ${result.paths.length - 8} more saved` : "",
					].filter(Boolean).join("\n"),
					result.candidatesAccepted > 0 ? "info" : "warning",
				);
				return;
			}

			if (subcommand === "list" || subcommand === "inbox" || subcommand === "active" || subcommand === "archive") {
				const dirs = memoryDirs();
				const mode = subcommand === "list" ? (rest.toLowerCase() || "all") : subcommand;
				const documents = mode === "inbox" || mode === "candidates"
					? await readMemoryDocuments(dirs.inbox)
					: mode === "active" || mode === "memories"
						? await readMemoryDocuments(dirs.memories)
						: mode === "archive" || mode === "rejected"
							? await readMemoryDocuments(dirs.archive)
							: await readAllMemoryDocuments();

				const visible = sortMemoriesNewestFirst(documents).slice(0, 20);
				if (visible.length === 0) {
					ctx.ui.notify(`No memories found for mode: ${mode}`, "info");
					return;
				}

				ctx.ui.notify(
					[
						`Memory notes (${mode}, showing ${visible.length}/${documents.length})`,
						...visible.map(formatCompactMemory),
					].join("\n"),
					"info",
				);
				return;
			}

			if (subcommand === "show") {
				const idOrPrefix = rest;
				if (!idOrPrefix) {
					ctx.ui.notify("Usage: /memory show <id-or-prefix>", "warning");
					return;
				}

				const { memory, error } = await resolveOneMemory(idOrPrefix);
				if (!memory) {
					ctx.ui.notify(error ?? "Memory not found", "warning");
					return;
				}

				ctx.ui.notify(formatDetailedMemory(memory), "info");
				return;
			}

			if (subcommand === "edit") {
				const idOrPrefix = rest;
				if (!idOrPrefix) {
					ctx.ui.notify("Usage: /memory edit <id-or-prefix>", "warning");
					return;
				}
				if (!ctx.hasUI) {
					ctx.ui.notify("/memory edit requires interactive UI mode", "warning");
					return;
				}

				const { memory, error } = await resolveOneMemory(idOrPrefix);
				if (!memory) {
					ctx.ui.notify(error ?? "Memory not found", "warning");
					return;
				}

				const originalMarkdown = formatMemoryMarkdown(memory.frontmatter, memory.content);
				const edited = await ctx.ui.editor(`Edit memory ${memory.frontmatter.id}`, originalMarkdown);
				if (edited === undefined || edited === originalMarkdown) {
					ctx.ui.notify("Memory edit cancelled or unchanged", "info");
					return;
				}

				const parsed = parseMemoryMarkdown(edited, memory.path);
				if (!parsed) {
					ctx.ui.notify("Edited memory is invalid: missing valid frontmatter with id", "error");
					return;
				}

				await writeFile(memory.path, formatMemoryMarkdown(parsed.frontmatter, parsed.content), "utf8");
				ctx.ui.notify(`Updated memory ${parsed.frontmatter.id}\nPath: ${memory.path}`, "info");
				return;
			}

			if (subcommand === "review") {
				if (!ctx.hasUI) {
					ctx.ui.notify("/memory review requires interactive UI mode", "warning");
					return;
				}

				let index = 0;
				while (true) {
					const candidates = sortMemoriesNewestFirst(await readMemoryDocuments(memoryDirs().inbox));
					if (candidates.length === 0) {
						ctx.ui.notify("No inbox memory candidates to review", "info");
						return;
					}
					if (index >= candidates.length) index = 0;

					const memory = candidates[index];
					const action = await ctx.ui.custom<ReviewAction | null>((_tui, theme, _kb, done) => ({
						render: (width) => renderReviewLines(memory, index, candidates.length, theme, width),
						invalidate: () => {},
						handleInput: (data: string) => {
							const key = data.toLowerCase();
							if (key === "p") return done("promote");
							if (key === "r") return done("reject");
							if (key === "e") return done("edit");
							if (key === "n" || matchesKey(data, Key.right) || matchesKey(data, Key.down)) return done("next");
							if (key === "q" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return done("quit");
						},
					}));

					if (!action || action === "quit") return;
					if (action === "next") {
						index = (index + 1) % candidates.length;
						continue;
					}
					if (action === "promote") {
						const targetPath = await promoteInboxMemory(memory);
						ctx.ui.notify(`Promoted memory ${memory.frontmatter.id}\nPath: ${targetPath}`, "info");
						continue;
					}
					if (action === "reject") {
						const targetPath = await rejectInboxMemory(memory);
						ctx.ui.notify(`Rejected memory ${memory.frontmatter.id}\nPath: ${targetPath}`, "info");
						continue;
					}
					if (action === "edit") {
						const originalMarkdown = formatMemoryMarkdown(memory.frontmatter, memory.content);
						const edited = await ctx.ui.editor(`Edit memory ${memory.frontmatter.id}`, originalMarkdown);
						if (edited === undefined || edited === originalMarkdown) {
							ctx.ui.notify("Memory edit cancelled or unchanged", "info");
							continue;
						}

						const parsed = parseMemoryMarkdown(edited, memory.path);
						if (!parsed) {
							ctx.ui.notify("Edited memory is invalid: missing valid frontmatter with id", "error");
							continue;
						}

						await writeFile(memory.path, formatMemoryMarkdown(parsed.frontmatter, parsed.content), "utf8");
						ctx.ui.notify(`Updated memory ${parsed.frontmatter.id}\nPath: ${memory.path}`, "info");
					}
				}
			}

			if (subcommand === "reject") {
				const idOrPrefix = rest;
				if (!idOrPrefix) {
					ctx.ui.notify("Usage: /memory reject <id-or-prefix>", "warning");
					return;
				}

				const matches = await findInboxMemoryById(idOrPrefix);
				if (matches.length === 0) {
					ctx.ui.notify(`No inbox candidate found for: ${idOrPrefix}`, "warning");
					return;
				}
				if (matches.length > 1) {
					ctx.ui.notify(`Multiple memories match ${idOrPrefix}:\n${matches.map((memory) => memory.frontmatter.id).join("\n")}`, "warning");
					return;
				}

				const memory = matches[0];
				const rejected: MemoryFrontmatter = {
					...memory.frontmatter,
					status: "rejected",
					bucket: "archived",
				};
				const targetPath = join(memoryDirs().archive, basename(memory.path));
				await writeFile(targetPath, formatMemoryMarkdown(rejected, memory.content), "utf8");
				await rm(memory.path, { force: true });

				ctx.ui.notify(`Rejected memory ${rejected.id}\nPath: ${targetPath}`, "info");
				return;
			}

			if (subcommand === "debug") {
				const decision = await readLatestInjectionDecision();
				if (!decision) {
					ctx.ui.notify("No memory injection decisions logged yet.", "info");
					return;
				}

				ctx.ui.notify(
					[
						`Latest memory injection decision`,
						`Time: ${decision.timestamp}`,
						`Inject: ${decision.inject ? "yes" : "no"}`,
						`Reason: ${decision.reason}`,
						`Confidence: ${decision.confidence}`,
						`Top score: ${decision.topScore}`,
						`Selected: ${decision.selectedMemoryIds.length ? decision.selectedMemoryIds.join(", ") : "none"}`,
						`Rejected top: ${decision.rejectedTopIds.length ? decision.rejectedTopIds.join(", ") : "none"}`,
						`Query: ${decision.query}`,
					].join("\n"),
					decision.inject ? "info" : "warning",
				);
				return;
			}

			if (subcommand === "promote") {
				const idOrPrefix = rest;
				if (!idOrPrefix) {
					ctx.ui.notify("Usage: /memory promote <id-or-prefix>", "warning");
					return;
				}

				const matches = await findInboxMemoryById(idOrPrefix);
				if (matches.length === 0) {
					ctx.ui.notify(`No inbox memory found for: ${idOrPrefix}`, "warning");
					return;
				}
				if (matches.length > 1) {
					ctx.ui.notify(`Multiple memories match ${idOrPrefix}:\n${matches.map((memory) => memory.frontmatter.id).join("\n")}`, "warning");
					return;
				}

				const memory = matches[0];
				const promoted: MemoryFrontmatter = {
					...memory.frontmatter,
					status: "active",
					bucket: memory.frontmatter.bucket === "archived" ? "active" : memory.frontmatter.bucket,
				};
				const targetPath = join(memoryDirs().memories, basename(memory.path));
				await writeFile(targetPath, formatMemoryMarkdown(promoted, memory.content), "utf8");
				await rm(memory.path, { force: true });

				ctx.ui.notify(`Promoted memory ${promoted.id}\nPath: ${targetPath}`, "info");
				return;
			}

			ctx.ui.notify(`Unknown memory command: ${subcommand}\nRun /memory help`, "warning");
		},
	});

	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description: "Search active, safe Pi memories. Returns ranked snippets from promoted active memories only.",
		promptSnippet: "Search active safe memories for relevant user/project context",
		promptGuidelines: [
			"Use memory_search when the user explicitly asks what you remember or when durable prior context would materially improve the answer.",
			"memory_search only returns promoted active memories; candidate inbox memories are intentionally excluded.",
		],
		parameters: MemorySearchParams,
		async execute(_toolCallId, params) {
			await ensureMemoryStore();
			const search = await searchMemoriesBestEffort(pi, params.query, {
				limit: params.limit,
				scope: params.scope,
				project: params.project,
			});
			const results = search.results;

			return {
				content: [
					{
						type: "text",
						text: results.length === 0
							? `No active matching memories found. Backend: ${search.backend}`
							: [`Backend: ${search.backend}`, "", ...results.map((result, index) => [
								`${index + 1}. ${result.id} score=${result.score}`,
								`   type=${result.type} scope=${result.scope}${result.project ? `/${result.project}` : ""}`,
								`   reasons=${result.reasons.join(", ") || "none"}`,
								`   ${result.snippet}`,
								`   path=${result.path}`,
							].join("\n"))].join("\n\n"),
					},
				],
				details: { query: params.query, backend: search.backend, results },
			};
		},
	});

	pi.registerTool({
		name: "memory_save",
		label: "Memory Save",
		description: "Save a durable future-useful memory as a candidate Markdown note. Secrets are rejected. Output is truncated to saved id/path.",
		promptSnippet: "Save durable future-useful information as a candidate memory",
		promptGuidelines: [
			"Use memory_save only for information likely to be useful in future sessions, such as durable preferences, decisions, procedures, project facts, or lessons.",
			"Do not use memory_save for temporary implementation details unless they are tied to an active project and likely useful later.",
			"Never pass secrets, API keys, passwords, tokens, or raw private credentials to memory_save.",
		],
		parameters: MemorySaveParams,
		async execute(_toolCallId, params) {
			await ensureMemoryStore();

			const saved = await writeCandidateMemory({
				content: params.content,
				type: (params.type ?? "unknown") as MemoryType,
				reason: params.reason,
				scope: (params.scope ?? "global") as MemoryScope,
				sensitivity: (params.sensitivity ?? "internal") as MemorySensitivity,
				confidence: params.confidence,
				project: params.project,
				source: "pi-session",
				source_ref: params.source_ref,
				task_tags: params.task_tags ?? [],
				links: params.links ?? [],
			});

			return {
				content: [
					{
						type: "text",
						text: `Saved candidate memory ${saved.id}\nPath: ${saved.path}\nStatus: ${saved.frontmatter.status}`,
					},
				],
				details: {
					id: saved.id,
					path: saved.path,
					status: "candidate",
					sensitivity: saved.frontmatter.sensitivity,
					scope: saved.frontmatter.scope,
					project: saved.frontmatter.project,
				},
			};
		},
	});
}
