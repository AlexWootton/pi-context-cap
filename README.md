# pi-opus-budget-guard

A tiny [pi](https://github.com/badlogic/pi-mono) extension that prevents long-context Anthropic Claude models (Opus 4.6, Opus 4.7, Sonnet 4.6, and any future 1M-window variants) from crossing Anthropic's **200k standard-tier pricing boundary**, above which input and output tokens are billed at roughly 2× the normal rate.

## The problem

Anthropic's long-context models have a 1,000,000-token window but price input and output at ~2× once a request crosses 200,000 input tokens. Pi's default auto-compaction trigger is:

```
contextTokens > contextWindow - reserveTokens
```

With a 1M window and the default `reserveTokens = 16384`, that means **compaction doesn't fire until ~983,616 tokens** — deep into long-context pricing. One long session can quietly rack up several times its normal cost before pi ever tries to compact.

## The fix

This extension mutates the reported `contextWindow` on affected models so it matches Anthropic's standard-tier ceiling. Pi's existing compaction logic then fires at the correct point. **No custom compaction code, no new event handlers on the hot path** — just a one-shot cap at `session_start`.

After install, on Claude Opus 4.7 (native 1M window) you'll see:

```
Context: 182,411 / 200,000 (91%)
```

...and pi auto-compacts around 183k tokens — exactly like it does on a native-200k model.

## Install

```bash
# From npm (recommended once published)
pi install npm:pi-opus-budget-guard

# Or directly from git
pi install git:github.com/AlexWootton/pi-opus-budget-guard

# Or local clone for development
git clone https://github.com/AlexWootton/pi-opus-budget-guard
pi install ./pi-opus-budget-guard
```

By default (no config required) the extension caps every model whose native `contextWindow > 200_000` down to exactly `200_000`. That's the intended setup for most users.

## Configure (optional)

Drop a JSON file at either path:

| Location | Scope |
|---|---|
| `~/.pi/agent/extensions/opus-budget-guard.json` | Global |
| `<project>/.pi/extensions/opus-budget-guard.json` | Project (overrides global) |

### Schema

```jsonc
{
  "cap": 200000,          // Target contextWindow for affected models.
  "appliesOver": 200000,  // Only cap models whose native window exceeds this.
  "models": {             // Per-model-id overrides (match by model.id).
    "claude-opus-4-7": 180000
  }
}
```

All keys are optional. Values shown are the defaults.

### Examples

**Be more conservative (36k buffer below 200k):**

```json
{ "cap": 180000 }
```

**Only cap a specific model:**

```json
{
  "cap": 999999999,
  "models": { "claude-opus-4-7": 200000 }
}
```

**Different cap per model:**

```json
{
  "models": {
    "claude-opus-4-7": 200000,
    "claude-sonnet-4-6": 180000
  }
}
```

Model IDs match `model.id` exactly; `/model` picker shows them, or check `~/.pi/agent/models.json` examples. Unknown IDs are silently ignored.

## What it does and doesn't do

**Does:**
- Cap `contextWindow` on matching models so pi's built-in auto-compaction fires before 200k.
- Show `capped N models` notification once on session start.
- Work with all of pi's compaction machinery (including `session_before_compact` hooks, manual `/compact`, and compaction error recovery) without modification.
- Apply project config on top of global config.

**Does not:**
- Replace or duplicate pi's compaction logic.
- Touch token billing, API requests, or the messages array.
- Affect models with native `contextWindow ≤ 200_000` (Opus 4, Opus 4.1, Sonnet 4.5, and so on).
- Prevent a *single* turn from crossing 200k if that turn's new content (large tool output, pasted document) exceeds the reserve buffer — see **Caveats** below.

## Caveats

Pi's compaction trigger checks the **previous assistant's** reported input-token usage. So if one turn adds more than `reserveTokens` (default ~16k tokens) of fresh content — say, three large file reads plus a long bash dump — the next request may be sent with >200k input tokens despite this extension being active.

For typical conversational coding, this is rare. For strict guarantees:

- Set `cap: 180000` to give yourself ~36k of headroom below the tier boundary.
- Or bump `compaction.reserveTokens` in `~/.pi/agent/settings.json` (but note this affects *all* models, not just the long-context ones).

## How it works

Pi's `ModelRegistry.getAll()` returns a live array of `Model` objects. The extension mutates `model.contextWindow` on each matching entry at `session_start` before any LLM request is built. Pi's [`shouldCompact()`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) reads this value directly:

```typescript
export function shouldCompact(contextTokens, contextWindow, settings) {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}
```

So the cap flows through to every existing compaction code path automatically. The extension itself is ~30 lines of logic.

### A note on extension load order

Extensions are loaded in this order:

1. Installed packages (from `settings.json`'s `packages` array)
2. Ad-hoc extensions passed via `--extension` / `-e`

Each extension's `session_start` handler fires in the same order. That means if you combine this guard with another extension loaded via `-e` that reads `contextWindow` in its own `session_start` handler, the other extension may see the *pre-cap* value. Mitigations:

- Read `contextWindow` in `before_agent_start` or later — by then the cap is applied.
- Or install both extensions as packages (order within packages is settings-file order).
- Or pass the guard first when using `-e`: `pi -e path/to/guard.ts -e path/to/other.ts`.

For typical single-extension usage, this is a non-issue.

## Uninstall

```bash
pi remove npm:pi-opus-budget-guard
```

Fully reversible. Pi's ModelRegistry is rebuilt on each launch from pi-ai's canonical model list, so removing the extension restores every affected model's native window on the next startup.

## License

MIT. See [LICENSE](./LICENSE).
