export interface CapConfig {
	/** Target contextWindow value to cap affected models at. */
	cap: number;
	/** Only cap models whose native contextWindow exceeds this value. */
	appliesOver: number;
	/** Case-insensitive `model.id` substrings; `"*"` matches every model. */
	matchPatterns: string[];
	/** Per-model-id overrides. Always win over pattern matching. */
	models: Record<string, number>;
}

export interface CappableModel {
	id: string;
	contextWindow?: number | null;
}

/** A session cap in absolute tokens or as a percentage of each model's native window. */
export type SessionCap = { tokens: number } | { percent: number };

export type CapCommand =
	| { kind: "status" }
	| { kind: "clear" }
	| { kind: "set"; cap: SessionCap };

/** Bare numbers up to this value are percentages; larger numbers are tokens. */
export const MAX_PERCENT = 100;

export const DEFAULT_CONFIG: CapConfig = {
	cap: 200_000,
	appliesOver: 200_000,
	matchPatterns: ["anthropic", "claude"],
	models: {},
};

// Shared across extension copies in one process so each sees the true native window.
const WINDOW_STATE = Symbol.for("pi-context-cap.window-state");

interface WindowState {
	native: number;
	applied: number;
}

type TrackedModel = CappableModel & { [WINDOW_STATE]?: WindowState };

/** Applies caps to models in place and returns how many are below their native window. */
export function applyCaps(models: Iterable<CappableModel>, cfg: CapConfig, sessionCap?: SessionCap): number {
	let cappedCount = 0;
	for (const model of models) {
		const native = nativeWindow(model);
		if (native === undefined) continue;
		const cap = resolveCap(model.id, native, cfg, sessionCap);
		const applied = cap === undefined ? native : Math.min(native, cap);
		setWindow(model, native, applied);
		if (applied < native) cappedCount++;
	}
	return cappedCount;
}

export function resolveCap(
	modelId: string,
	native: number,
	cfg: CapConfig,
	sessionCap?: SessionCap,
): number | undefined {
	if (sessionCap !== undefined) return sessionCapTokens(sessionCap, native);
	const perModelCap = cfg.models[modelId];
	if (perModelCap !== undefined) return perModelCap;
	const overThresholds = native > cfg.appliesOver && native > cfg.cap;
	return overThresholds && matchesPatterns(modelId, cfg.matchPatterns) ? cfg.cap : undefined;
}

export function sessionCapTokens(cap: SessionCap, native: number): number {
	return "tokens" in cap ? cap.tokens : Math.max(1, Math.floor((native * cap.percent) / MAX_PERCENT));
}

export function nativeWindow(model: CappableModel): number | undefined {
	const current = model.contextWindow;
	if (current == null || current <= 0) return undefined;
	const state = (model as TrackedModel)[WINDOW_STATE];
	// A different current value means another writer (for example an alias mirror) replaced it.
	return state && state.applied === current ? state.native : current;
}

export function parseCapCommand(args: string): CapCommand {
	const input = args.trim().toLowerCase();
	if (input === "" || input === "status") return { kind: "status" };
	if (["off", "reset", "clear", "default"].includes(input)) return { kind: "clear" };
	if (input === "max") return { kind: "set", cap: { percent: MAX_PERCENT } };
	return { kind: "set", cap: parseSessionCap(input) };
}

/** Parses `50`/`50%` as percent of native, `200000`/`200k`/`1m` as tokens. */
export function parseSessionCap(input: string): SessionCap {
	const match = /^(\d+(?:\.\d+)?)([km%]?)$/.exec(input.trim().toLowerCase().replace(/[,_]/g, ""));
	if (!match) throw new Error(`invalid cap "${input}"; use e.g. 50, 50%, 200k, 1m, or max`);
	const value = Number(match[1]);
	const unit = match[2];
	if (value <= 0) throw new Error("cap must be greater than zero");
	if (unit === "%" || (unit === "" && value <= MAX_PERCENT)) return { percent: parsePercent(value) };
	const multiplier = unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1;
	return { tokens: Math.round(value * multiplier) };
}

export function formatSessionCap(cap: SessionCap): string {
	if ("tokens" in cap) return `${formatTokens(cap.tokens)} tokens`;
	return cap.percent === MAX_PERCENT ? "max (native windows)" : `${cap.percent}% of native`;
}

export function formatTokens(tokens: number): string {
	return tokens.toLocaleString("en-US");
}

function parsePercent(value: number): number {
	if (value > MAX_PERCENT) throw new Error(`percent cap must be at most ${MAX_PERCENT}%`);
	return value;
}

function matchesPatterns(modelId: string, patterns: string[]): boolean {
	const id = modelId.toLowerCase();
	return patterns.some((p) => p === "*" || id.includes(p.toLowerCase()));
}

function setWindow(model: CappableModel, native: number, applied: number): void {
	model.contextWindow = applied;
	Object.defineProperty(model, WINDOW_STATE, {
		value: { native, applied },
		configurable: true,
		enumerable: false,
		writable: true,
	});
}
