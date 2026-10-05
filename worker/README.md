# The Break Room — API

The page `break-room.html` is static and lives on GitHub Pages. It cannot hold the
Anthropic key, because anything in the browser is public. This Worker holds the key,
adds the caps, and streams the reply back.

## Deploy

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY   # paste the key when prompted
npx wrangler deploy
```

`deploy` prints a URL like `https://break-room-api.<subdomain>.workers.dev`.
Put that URL in `break-room.html`, in the `API` constant near the bottom.

Then set the origins allowed to call it, in `wrangler.toml`:

```toml
ALLOWED_ORIGINS = "https://lauraledesna.io,http://localhost:8000"
```

Redeploy after changing it.

## Local development

```bash
npx wrangler dev          # serves the API on http://localhost:8787
```

Point the `API` constant at `http://localhost:8787` while testing, and serve the
site itself on port 8000 so it matches the allowed origin.

## What bounds the cost

The model is `claude-opus-5` at $5 / 1M input tokens and $25 / 1M output tokens.

Four caps live in `src/index.ts`:

| Cap | Value | What it stops |
|---|---|---|
| `MAX_OUTPUT` | 400 tokens | A single reply costing more than ~$0.01 |
| `MAX_TURNS` | 12 messages | History growing without limit inside one conversation |
| `MAX_CHARS` | 1500 | Someone pasting a novel to burn input tokens |
| `RATE_LIMIT` | 30 / IP / hour | Casual hammering |

Roughly: a turn costs under 2 cents, a six-turn conversation about 10 cents, and a
hundred conversations about $10.

The rate limit is best effort — it lives in the Worker's memory, so it resets when the
isolate is evicted and is not shared between Cloudflare locations. It is a speed bump,
not a wall.

**The real backstop is a spend limit in the Anthropic Console.** Set one before you
publish the page. That is the only control that cannot be worked around.

## Turning the cost down

Two levers, in order:

1. `output_config: { effort: "low" }` is already set. Chat does not need more.
2. Switching `MODEL` to `claude-sonnet-5` ($2 / $10) cuts the bill by about 60%.
   Worth measuring against Opus on your own probes before deciding — the whole point
   of the page is how well the agent handles pressure, and that is exactly where
   models differ.

## Where the design lives

The agent's behaviour is the `SYSTEM` constant in `src/index.ts`. It is not a generic
assistant prompt — it is the escalation ladder from the B100 case study, written as
instructions:

- **Three levels.** L1 ambient (the system speaks first), L2 copilot (answers and cites,
  never acts), L3 agentic (propose, approve, act). The agent reports its level on every
  reply and the page lights the matching rung.
- **Five patterns.** Confidence signal, citation and sourcing, permission model,
  graceful degradation, escape hatch. Every reply names the one it just used.
- **Where it doesn't go.** Declared up front rather than discovered on refusal.

## Wire format

The model returns prose, then the delimiter `⟡META⟡`, then `key: value` lines:

```
level: L2
confidence: High. This is sourced, not inferred.
sources: MedBridge case study, Homepage
pattern: Confidence signal
note: Held its position under pressure.
```

Plus, only when proposing an action, `action`, `action_type` (Safe / Reversible /
Destructive) and `action_scope` (clauses separated by `|`). The page streams the prose
as it arrives and renders the metadata once the delimiter lands, so the reply still
types itself out.

Change the prompt to change the agent. The code around it does not need to move.
