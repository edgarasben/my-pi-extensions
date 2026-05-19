import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, SessionManager } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { Buffer } from "node:buffer";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

type ProjectInfo = {
	cwd: string;
	count: number;
	latest: number;
	latestFile: string;
	files: string[];
};

function readFirstLine(filePath: string, maxBytes = 64 * 1024): string | null {
	const fd = openSync(filePath, "r");
	try {
		const chunks: Buffer[] = [];
		let totalBytes = 0;

		while (totalBytes < maxBytes) {
			const bytesToRead = Math.min(8192, maxBytes - totalBytes);
			const buffer = Buffer.allocUnsafe(bytesToRead);
			const bytesRead = readSync(fd, buffer, 0, bytesToRead, null);
			if (bytesRead === 0) break;

			const chunk = buffer.subarray(0, bytesRead);
			const newlineIndex = chunk.indexOf(10);
			if (newlineIndex >= 0) {
				chunks.push(chunk.subarray(0, newlineIndex));
				return Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
			}

			chunks.push(chunk);
			totalBytes += bytesRead;
		}

		if (chunks.length === 0) return null;
		return Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
	} finally {
		closeSync(fd);
	}
}

function readProjects(): ProjectInfo[] {
	const sessionsRoot = process.env.PI_CODING_AGENT_SESSION_DIR ?? join(homedir(), ".pi", "agent", "sessions");
	if (!existsSync(sessionsRoot)) return [];

	const projects = new Map<string, ProjectInfo>();

	for (const dirent of readdirSync(sessionsRoot, { withFileTypes: true })) {
		if (!dirent.isDirectory()) continue;

		const dir = join(sessionsRoot, dirent.name);
		for (const file of readdirSync(dir, { withFileTypes: true })) {
			if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;

			const filePath = join(dir, file.name);
			try {
				const firstLine = readFirstLine(filePath);
				if (!firstLine) continue;

				const cwd = JSON.parse(firstLine)?.cwd;
				if (typeof cwd !== "string" || cwd.length === 0) continue;

				const mtime = statSync(filePath).mtimeMs;
				const existing = projects.get(cwd);
				if (existing) {
					existing.count += 1;
					existing.files.push(filePath);
					if (mtime > existing.latest) {
						existing.latest = mtime;
						existing.latestFile = filePath;
					}
				} else {
					projects.set(cwd, { cwd, count: 1, latest: mtime, latestFile: filePath, files: [filePath] });
				}
			} catch {
				// Ignore malformed or partially-written session files.
			}
		}
	}

	return [...projects.values()].sort((a, b) => b.latest - a.latest || a.cwd.localeCompare(b.cwd));
}

function deleteProjectSessions(project: ProjectInfo): number {
	let deleted = 0;
	for (const file of project.files) {
		try {
			unlinkSync(file);
			deleted++;
		} catch {
			// Ignore files that were already removed or cannot be deleted.
		}
	}
	return deleted;
}

function formatRelativeTime(timestamp: number): string {
	const diffMs = Math.max(0, Date.now() - timestamp);
	const minute = 60 * 1000;
	const hour = 60 * minute;
	const day = 24 * hour;

	if (diffMs < minute) return "just now";
	if (diffMs < hour) {
		const minutes = Math.floor(diffMs / minute);
		return `${minutes}m ago`;
	}
	if (diffMs < day) {
		const hours = Math.floor(diffMs / hour);
		return `${hours}h ago`;
	}

	const days = Math.floor(diffMs / day);
	return `${days}d ago`;
}

export default function projectsExtension(pi: ExtensionAPI) {
	pi.registerCommand("projects", {
		description: "List project paths that have Pi sessions",
		getArgumentCompletions: (prefix) => {
			const items = ["all"].map((value) => ({ value, label: value }));
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const projects = readProjects();
			if (projects.length === 0) {
				ctx.ui.notify("No Pi session projects found", "info");
				return;
			}

			const mode = args.trim();
			const visibleProjects = mode === "all" ? projects : projects.slice(0, 50);
			const projectByValue = new Map<string, ProjectInfo>();
			const longestName = Math.min(32, Math.max(...visibleProjects.map((project) => (basename(project.cwd) || project.cwd).length)));
			const items: SelectItem[] = visibleProjects.map((project) => {
				const name = basename(project.cwd) || project.cwd;
				const paddedName = name.length > longestName ? name.slice(0, longestName - 1) + "…" : name.padEnd(longestName);
				projectByValue.set(project.cwd, project);
				return {
					value: project.cwd,
					label: paddedName,
					description: `${formatRelativeTime(project.latest).padEnd(8)} ${project.cwd}`,
				};
			});

			const suffix = mode === "all" || projects.length <= 50 ? "" : " — latest 50; use /projects all for all";
			const result = await ctx.ui.custom<{ action: "open" | "delete"; cwd: string } | null>((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(new Text(theme.fg("accent", theme.bold(`Open new Pi session (${projects.length} projects)${suffix}`)), 1, 0));

				const selectList = new SelectList(items, Math.min(items.length, 12), {
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", t),
					description: (t) => theme.fg("dim", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				});
				selectList.onSelect = (item) => done({ action: "open", cwd: item.value });
				selectList.onCancel = () => done(null);
				container.addChild(selectList);
				container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter open new session • ctrl+d delete project sessions • esc cancel"), 1, 0));
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				return {
					render: (width) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						if (matchesKey(data, Key.ctrl("d"))) {
							const item = selectList.getSelectedItem?.();
							if (item) done({ action: "delete", cwd: item.value });
							return;
						}
						selectList.handleInput(data);
						tui.requestRender();
					},
				};
			});
			if (!result) return;

			const project = projectByValue.get(result.cwd);
			if (!project) return;

			if (result.action === "delete") {
				const ok = await ctx.ui.confirm(
					"Delete project sessions?",
					`Delete ${project.count} Pi session${project.count === 1 ? "" : "s"} for:\n${project.cwd}\n\nThis removes session history for this project.`,
				);
				if (!ok) return;

				const deleted = deleteProjectSessions(project);
				ctx.ui.notify(`Deleted ${deleted} session${deleted === 1 ? "" : "s"} for ${project.cwd}`, "info");
				return;
			}

			const sessionManager = SessionManager.create(project.cwd);
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify(`Could not create a new session for ${project.cwd}`, "error");
				return;
			}

			// SessionManager defers creating a fresh session file until the first
			// assistant response, but switchSession() needs a readable header to learn
			// the target cwd. Write a temporary header, switch, then remove it again so
			// merely opening a project does not create an empty session in history.
			let wroteTemporaryHeader = false;
			if (!existsSync(sessionFile)) {
				const header = sessionManager.getHeader();
				if (!header) {
					ctx.ui.notify(`Could not create a session header for ${project.cwd}`, "error");
					return;
				}
				writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, "utf8");
				wroteTemporaryHeader = true;
			}

			await ctx.switchSession(sessionFile, {
				withSession: async (ctx) => {
					if (wroteTemporaryHeader) {
						try {
							unlinkSync(sessionFile);
							// setSessionFile() marks an existing header-only file as flushed. After
							// deleting the temporary file, restore deferred persistence so the first
							// assistant response writes the full session, including its header.
							(ctx.sessionManager as unknown as { flushed: boolean }).flushed = false;
						} catch {
							// If cleanup fails, keep the switched session rather than aborting.
						}
					}
					ctx.ui.notify(`New session opened in ${project.cwd}`, "info");
				},
			});

		},
	});
}
