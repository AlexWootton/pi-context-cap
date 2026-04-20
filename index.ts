/**
 * pi-opus-budget-guard
 *
 * Caps the reported `contextWindow` on long-context Anthropic Claude models
 * (Opus 4.6 / 4.7 / Sonnet 4.6 and future 1M-window variants) so pi's
 * built-in auto-compaction fires *before* crossing Anthropic's 200k
 * standard-tier pricing boundary.
 *
 * No custom compaction logic — we just tell pi the window is smaller and
 * let its existing `contextTokens > contextWindow - reserveTokens` trigger
 * do the work. All existing compaction behavior (hooks, summarization,
 * error handling) is preserved.
 *
 * Config (optional; defaults auto-cap every model with contextWindow > 200k):
 *
 *   ~/.pi/agent/extensions/opus-budget-guard.json        (global)
 *   <cwd>/.pi/extensions/opus-budget-guard.json          (project override)
 *
 *   {
 *     "cap": 200000,                 // default contextWindow cap
 *     "appliesOver": 200000,         // only touch models with native window > this
 *     "models": {                    // per-id overrides (by model.id)
 *       "claude-opus-4-7": 180000
 *     }
 *   }
 *
 * Caveat: pi's compaction trigger uses the *previous* assistant's reported
 * input-token count, so a single turn that injects more than `reserveTokens`
 * worth of new content (large tool output, pasted doc) can still cross 200k.
 * For typical workflows this is rare; for strict guarantees set `cap` lower
 * (e.g. 180000).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface GuardConfig {
	/** Target contextWindow value to cap affected models at. */
	cap: number;
	/** Only cap models whose native contextWindow exceeds this value. */
	appliesOver: number;
	/** Per-model-id overrides. Matches model.id regardless of provider. */
	models: Record<string, number>;
}

const DEFAULT_CONFIG: GuardConfig = {
	cap: 200_000,
	appliesOver: 200_000,
	models: {},
};

function loadConfig(cwd: string): GuardConfig {
	const paths = [
		join(getAgentDir(), "extensions", "opus-budget-guard.json"),
		join(cwd, ".pi", "extensions", "opus-budget-guard.json"),
	];

	let cfg: GuardConfig = { ...DEFAULT_CONFIG, models: { ...DEFAULT_CONFIG.models } };

	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<GuardConfig>;
			cfg = {
				cap: raw.cap ?? cfg.cap,
				appliesOver: raw.appliesOver ?? cfg.appliesOver,
				models: { ...cfg.models, ...(raw.models ?? {}) },
			};
		} catch (e) {
			console.error(`[opus-budget-guard] could not parse ${path}: ${e}`);
		}
	}

	return cfg;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const cfg = loadConfig(ctx.cwd);

		let cappedCount = 0;
		for (const model of ctx.modelRegistry.getAll()) {
			const native = model.contextWindow;
			if (native == null || native <= 0) continue;

			// Per-model override wins over global cap.
			const perModelCap = cfg.models[model.id];
			if (perModelCap !== undefined) {
				if (native > perModelCap) {
					model.contextWindow = perModelCap;
					cappedCount++;
				}
				continue;
			}

			// Global cap applies only when the native window exceeds the trigger threshold.
			if (native > cfg.appliesOver && native > cfg.cap) {
				model.contextWindow = cfg.cap;
				cappedCount++;
			}
		}

		if (cappedCount > 0) {
			ctx.ui.notify(
				`opus-budget-guard: capped ${cappedCount} model(s) to ≤ ${cfg.cap.toLocaleString()} tokens`,
				"info",
			);
		}
	});
}
