/**
 * pi-context-cap
 *
 * Caps the reported `contextWindow` on selected models so pi's built-in
 * auto-compaction fires earlier than the model's native limit. No custom
 * compaction logic: pi's `contextTokens > contextWindow - reserveTokens`
 * trigger does the work.
 *
 * Config: ~/.pi/agent/extensions/context-cap.json, then
 * <cwd>/.pi/extensions/context-cap.json. `/context-cap <tokens|percent>` sets a
 * session-local cap that overrides config for every model in this session.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	applyCaps,
	type CapConfig,
	DEFAULT_CONFIG,
	formatSessionCap,
	formatTokens,
	nativeWindow,
	parseCapCommand,
	resolveCap,
	type SessionCap,
} from "./caps.ts";

const ENTRY_TYPE = "context-cap";
const COMPLETIONS = ["status", "off", "max", "50", "75", "128k", "200k", "272k", "400k", "500k", "1m"];

type SessionCapEntry = Partial<{ tokens: number; percent: number }>;

export default function (pi: ExtensionAPI) {
	let cfg: CapConfig = DEFAULT_CONFIG;
	let sessionCap: SessionCap | undefined;

	pi.on("session_start", async (_event, ctx) => {
		cfg = loadConfig(ctx.cwd);
		sessionCap = restoreSessionCap(ctx);
		const cappedCount = apply(ctx);
		if (cappedCount > 0) ctx.ui.notify(`context-cap: ${describeActiveCap()} (${cappedCount} model(s))`, "info");
	});

	pi.on("session_tree", async (_event, ctx) => {
		sessionCap = restoreSessionCap(ctx);
		apply(ctx);
	});

	// Providers can refresh model metadata after session_start, so reapply before compaction checks.
	pi.on("model_select", async (_event, ctx) => void apply(ctx));
	pi.on("input", async (_event, ctx) => void apply(ctx));
	pi.on("before_agent_start", async (_event, ctx) => void apply(ctx));
	pi.on("message_end", async (_event, ctx) => void apply(ctx));

	pi.registerCommand("context-cap", {
		description: "Show or set a session-local context-window cap: /context-cap [50|200k|max|off]",
		getArgumentCompletions: (prefix) =>
			COMPLETIONS.filter((value) => value.startsWith(prefix.trim().toLowerCase())).map((value) => ({
				value,
				label: value,
			})),
		handler: async (args, ctx) => {
			try {
				runCommand(args, ctx);
			} catch (error) {
				ctx.ui.notify(`context-cap: ${(error as Error).message}`, "error");
			}
		},
	});

	function runCommand(args: string, ctx: ExtensionContext): void {
		const command = parseCapCommand(args);
		if (command.kind !== "status") {
			sessionCap = command.kind === "set" ? command.cap : undefined;
			pi.appendEntry<SessionCapEntry>(ENTRY_TYPE, sessionCap ?? {});
		}
		apply(ctx);
		ctx.ui.notify(`context-cap: ${describeStatus(ctx)}`, "info");
	}

	function apply(ctx: ExtensionContext): number {
		const cappedCount = applyCaps(ctx.modelRegistry.getAll(), cfg, sessionCap);
		// The active session model can be a copy of its registry entry.
		if (ctx.model) applyCaps([ctx.model], cfg, sessionCap);
		return cappedCount;
	}

	function describeActiveCap(): string {
		if (sessionCap === undefined) return `config cap ≤ ${formatTokens(cfg.cap)} tokens`;
		return `session cap ${formatSessionCap(sessionCap)}`;
	}

	function describeStatus(ctx: ExtensionContext): string {
		const model = ctx.model;
		const native = model ? nativeWindow(model) : undefined;
		if (!model || native === undefined) return describeActiveCap();
		const configured = resolveCap(model.id, native, cfg);
		const parts = [
			describeActiveCap(),
			`${model.id}: ${formatTokens(model.contextWindow)} / native ${formatTokens(native)}`,
		];
		if (sessionCap !== undefined && configured !== undefined) parts.push(`config ${formatTokens(configured)}`);
		if (sessionCap !== undefined && "tokens" in sessionCap && sessionCap.tokens > native) {
			parts.push("cap exceeds native window");
		}
		return parts.join("; ");
	}
}

function restoreSessionCap(ctx: ExtensionContext): SessionCap | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
			return fromEntry(entry.data as SessionCapEntry | undefined);
		}
	}
	return undefined;
}

function fromEntry(entry: SessionCapEntry | undefined): SessionCap | undefined {
	if (entry?.tokens !== undefined) return { tokens: entry.tokens };
	if (entry?.percent !== undefined) return { percent: entry.percent };
	return undefined;
}

function loadConfig(cwd: string): CapConfig {
	const paths = [
		join(getAgentDir(), "extensions", "context-cap.json"),
		join(cwd, ".pi", "extensions", "context-cap.json"),
	];

	let cfg: CapConfig = {
		...DEFAULT_CONFIG,
		matchPatterns: [...DEFAULT_CONFIG.matchPatterns],
		models: { ...DEFAULT_CONFIG.models },
	};

	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<CapConfig>;
			cfg = {
				cap: raw.cap ?? cfg.cap,
				appliesOver: raw.appliesOver ?? cfg.appliesOver,
				matchPatterns: raw.matchPatterns ?? cfg.matchPatterns,
				models: { ...cfg.models, ...(raw.models ?? {}) },
			};
		} catch (e) {
			console.error(`[context-cap] could not parse ${path}: ${e}`);
		}
	}

	return cfg;
}
