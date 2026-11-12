import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyCaps,
	type CapConfig,
	DEFAULT_CONFIG,
	formatSessionCap,
	nativeWindow,
	parseCapCommand,
	parseSessionCap,
} from "../caps.ts";

const CONFIG: CapConfig = { cap: 200_000, appliesOver: 200_000, matchPatterns: ["claude"], models: {} };

function claude(contextWindow = 1_000_000) {
	return { id: "claude-opus", contextWindow };
}

describe("applyCaps", () => {
	it("applies the configured cap to matching models", () => {
		const model = claude();
		assert.equal(applyCaps([model], CONFIG), 1);
		assert.equal(model.contextWindow, 200_000);
	});

	it("leaves non-matching models unchanged", () => {
		const model = { id: "gpt", contextWindow: 1_000_000 };
		assert.equal(applyCaps([model], CONFIG), 0);
		assert.equal(model.contextWindow, 1_000_000);
	});

	it("lets a per-model override win over patterns", () => {
		const model = claude();
		applyCaps([model], { ...CONFIG, models: { "claude-opus": 300_000 } });
		assert.equal(model.contextWindow, 300_000);
	});

	it("lets a token session cap override config for every model", () => {
		const models = [claude(), { id: "gpt", contextWindow: 400_000 }];
		applyCaps(models, CONFIG, { tokens: 128_000 });
		assert.deepEqual(models.map((m) => m.contextWindow), [128_000, 128_000]);
	});

	it("scales a percent session cap by each native window", () => {
		const models = [claude(), { id: "gpt", contextWindow: 400_000 }];
		applyCaps(models, CONFIG);
		applyCaps(models, CONFIG, { percent: 50 });
		assert.deepEqual(models.map((m) => m.contextWindow), [500_000, 200_000]);
	});

	it("raises a session cap above config up to the native window", () => {
		const model = claude();
		applyCaps([model], CONFIG);
		applyCaps([model], CONFIG, { tokens: 500_000 });
		assert.equal(model.contextWindow, 500_000);
		applyCaps([model], CONFIG, { tokens: 2_000_000 });
		assert.equal(model.contextWindow, 1_000_000);
	});

	it("restores native windows for a 100 percent session cap", () => {
		const models = [claude(), { id: "claude-sonnet", contextWindow: 1_000_000 }];
		applyCaps(models, { ...CONFIG, models: { "claude-sonnet": 100_000 } });
		assert.equal(applyCaps(models, CONFIG, { percent: 100 }), 0);
		assert.deepEqual(models.map((m) => m.contextWindow), [1_000_000, 1_000_000]);
	});

	it("restores the configured cap when the session cap clears", () => {
		const model = claude();
		applyCaps([model], CONFIG, { tokens: 100_000 });
		applyCaps([model], CONFIG);
		assert.equal(model.contextWindow, 200_000);
	});

	it("treats an externally replaced window as the new native window", () => {
		const model = claude();
		applyCaps([model], CONFIG);
		model.contextWindow = 400_000;
		assert.equal(nativeWindow(model), 400_000);
	});

	it("skips models without a positive window", () => {
		assert.equal(applyCaps([{ id: "claude", contextWindow: 0 }, { id: "claude" }], DEFAULT_CONFIG), 0);
	});
});

describe("parseCapCommand", () => {
	it("returns status for empty input", () => assert.deepEqual(parseCapCommand("  "), { kind: "status" }));
	it("returns clear for off", () => assert.deepEqual(parseCapCommand("OFF"), { kind: "clear" }));
	it("returns 100 percent for max", () => {
		assert.deepEqual(parseCapCommand("Max"), { kind: "set", cap: { percent: 100 } });
	});
	it("returns set for a token count", () => {
		assert.deepEqual(parseCapCommand("200k"), { kind: "set", cap: { tokens: 200_000 } });
	});
});

describe("parseSessionCap", () => {
	it("parses bare numbers up to 100 as percent", () => {
		assert.deepEqual(["50", "100", "12.5"].map(parseSessionCap), [{ percent: 50 }, { percent: 100 }, { percent: 12.5 }]);
	});

	it("parses a percent suffix", () => assert.deepEqual(parseSessionCap("75%"), { percent: 75 }));

	it("parses larger numbers and suffixes as tokens", () => {
		assert.deepEqual(
			["101", "1m", "1.5M", "200,000", "128_000"].map(parseSessionCap),
			[{ tokens: 101 }, { tokens: 1_000_000 }, { tokens: 1_500_000 }, { tokens: 200_000 }, { tokens: 128_000 }],
		);
	});

	it("rejects percent above 100", () => assert.throws(() => parseSessionCap("150%"), /at most 100%/));
	it("rejects invalid input", () => assert.throws(() => parseSessionCap("lots"), /invalid cap/));
	it("rejects zero", () => assert.throws(() => parseSessionCap("0"), /greater than zero/));
});

describe("formatSessionCap", () => {
	it("formats tokens", () => assert.equal(formatSessionCap({ tokens: 200_000 }), "200,000 tokens"));
	it("formats percent", () => assert.equal(formatSessionCap({ percent: 50 }), "50% of native"));
	it("formats 100 percent as max", () => assert.equal(formatSessionCap({ percent: 100 }), "max (native windows)"));
});
