import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, SessionManager } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, Key, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
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

type ProjectAction = { action: "open" | "resume" | "delete"; cwd: string };
type ProjectView = "recent" | "popular";

const FIRST_LINE_MAX_BYTES = 64 * 1024;
const MAX_PROJECT_NAME_WIDTH = 32;
const MAX_VISIBLE_PROJECTS = 12;

function readFirstLine(filePath: string, maxBytes = FIRST_LINE_MAX_BYTES): string | null {
	const fd = openSync(filePath, "r");
	try {
		const buffer = Buffer.allocUnsafe(maxBytes);
		const bytesRead = readSync(fd, buffer, 0, maxBytes, null);
		if (bytesRead === 0) return null;

		const chunk = buffer.subarray(0, bytesRead);
		const newlineIndex = chunk.indexOf(10);
		return chunk.subarray(0, newlineIndex >= 0 ? newlineIndex : undefined).toString("utf8").replace(/\r$/, "");
	} finally {
		closeSync(fd);
	}
}

function isExistingDirectory(path: string): boolean {
	try {
		return existsSync(path) && statSync(path).isDirectory();
	} catch {
		return false;
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
				if (typeof cwd !== "string" || cwd.length === 0 || !isExistingDirectory(cwd)) continue;

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

function sortProjects(projects: ProjectInfo[], view: ProjectView): ProjectInfo[] {
	return [...projects].sort((a, b) => {
		if (view === "popular") return b.count - a.count || b.latest - a.latest || a.cwd.localeCompare(b.cwd);
		return b.latest - a.latest || a.cwd.localeCompare(b.cwd);
	});
}

function buildProjectItems(projects: ProjectInfo[], view: ProjectView): SelectItem[] {
	const sortedProjects = sortProjects(projects, view);
	const longestName = Math.min(MAX_PROJECT_NAME_WIDTH, Math.max(...sortedProjects.map((project) => (basename(project.cwd) || project.cwd).length)));

	return sortedProjects.map((project) => {
		const name = basename(project.cwd) || project.cwd;
		const label = name.length > longestName ? `${name.slice(0, longestName - 1)}…` : name.padEnd(longestName);
		const sessionText = `${project.count} session${project.count === 1 ? "" : "s"}`;
		const description = view === "popular"
			? `${sessionText.padEnd(11)} ${formatRelativeTime(project.latest).padEnd(8)} ${project.cwd}`
			: `${formatRelativeTime(project.latest).padEnd(8)} ${sessionText.padEnd(11)} ${project.cwd}`;
		return {
			value: project.cwd,
			label,
			description,
		};
	});
}

function setSelectListItems(selectList: SelectList, items: SelectItem[], filteredItems: SelectItem[]): void {
	Object.assign(selectList as unknown as { items: SelectItem[]; filteredItems: SelectItem[]; selectedIndex: number; maxVisible: number }, {
		items,
		filteredItems,
		selectedIndex: 0,
		maxVisible: Math.min(Math.max(items.length, 1), MAX_VISIBLE_PROJECTS),
	});
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
		handler: async (_args, ctx) => {
			while (true) {
				const projects = readProjects();
				if (projects.length === 0) {
					ctx.ui.notify("No Pi session projects found", "info");
					return;
				}

				const projectByValue = new Map(projects.map((project) => [project.cwd, project]));
				let newSessionStatusText = "✓ New session started";

				const result = await ctx.ui.custom<ProjectAction | null>((tui, theme, _kb, done) => {
				newSessionStatusText = theme.fg("accent", "✓ New session started");
				let view: ProjectView = "recent";
				let items = buildProjectItems(projects, view);
				const formatTabs = () => [
					view === "recent" ? theme.fg("accent", theme.bold("Recent")) : theme.fg("dim", "Recent"),
					view === "popular" ? theme.fg("accent", theme.bold("Popular")) : theme.fg("dim", "Popular"),
				].join(theme.fg("dim", " | "));
				const container = new Container();
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(new Text(theme.fg("accent", theme.bold(`Open new Pi session — ${projects.length} projects`)), 1, 0));
				const tabsText = new Text(formatTabs(), 1, 0);
				container.addChild(tabsText);

				const searchInput = new Input();
				const selectList = new SelectList([], MAX_VISIBLE_PROJECTS, {
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", t),
					description: (t) => theme.fg("dim", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				});
				const applyItems = () => {
					const query = searchInput.getValue().trim();
					const filteredItems = query ? fuzzyFilter(items, query, (item) => `${item.label} ${item.value} ${item.description ?? ""}`) : items;
					setSelectListItems(selectList, items, filteredItems);
				};
				const switchView = () => {
					view = view === "recent" ? "popular" : "recent";
					items = buildProjectItems(projects, view);
					tabsText.setText(formatTabs());
					applyItems();
				};
				applyItems();
				selectList.onSelect = (item) => done({ action: "open", cwd: item.value });
				selectList.onCancel = () => done(null);
				container.addChild(new Text(theme.fg("dim", "Search projects:"), 1, 0));
				container.addChild(searchInput);
				container.addChild(selectList);
				container.addChild(new Text(theme.fg("dim", "tab switch view • type to search • ↑↓ navigate • enter new session • ctrl+r resume latest • ctrl+d delete • esc cancel"), 1, 0));
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				return {
					render: (width) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						if (matchesKey(data, Key.tab)) {
							switchView();
							tui.requestRender();
							return;
						}

						if (matchesKey(data, Key.ctrl("d"))) {
							const item = selectList.getSelectedItem?.();
							if (item) done({ action: "delete", cwd: item.value });
							return;
						}
						if (matchesKey(data, Key.ctrl("r"))) {
							const item = selectList.getSelectedItem?.();
							if (item) done({ action: "resume", cwd: item.value });
							return;
						}

						if (
							matchesKey(data, Key.up) ||
							matchesKey(data, Key.down) ||
							matchesKey(data, Key.enter) ||
							matchesKey(data, Key.escape) ||
							matchesKey(data, Key.ctrl("c"))
						) {
							selectList.handleInput(data);
							tui.requestRender();
							return;
						}

						const previousSearch = searchInput.getValue();
						searchInput.handleInput(data);
						if (previousSearch !== searchInput.getValue()) applyItems();
						tui.requestRender();
					},
				};
				});
				if (!result) return;

				const project = projectByValue.get(result.cwd);
				if (!project) continue;

				if (result.action === "delete") {
					const ok = await ctx.ui.confirm(
						"Delete project sessions?",
						`Delete ${project.count} Pi session${project.count === 1 ? "" : "s"} for:\n${project.cwd}\n\nThis removes session history for this project.`,
					);
					if (!ok) continue;

					const deleted = deleteProjectSessions(project);
					ctx.ui.notify(`Deleted ${deleted} session${deleted === 1 ? "" : "s"} for ${project.cwd}`, "info");
					continue;
				}

				if (!isExistingDirectory(project.cwd)) {
					ctx.ui.notify(`Project path no longer exists: ${project.cwd}`, "warning");
					return;
				}

			if (result.action === "resume") {
				await ctx.switchSession(project.latestFile, {
					withSession: async (ctx) => {
						ctx.ui.notify(`Resumed latest session in ${project.cwd}`, "info");
					},
				});
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

					// switchSession() always prints "Resumed session" after this callback.
					// Defer our message so opening a project matches Pi's /new success text/color.
					setTimeout(() => ctx.ui.notify(newSessionStatusText, "info"), 0);
				},
			});
			return;
		}
		},
	});
}
