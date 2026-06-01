import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import memory from "./memory";
import projects from "./projects";

export default function myExtensions(pi: ExtensionAPI) {
	projects(pi);
	memory(pi);
}
