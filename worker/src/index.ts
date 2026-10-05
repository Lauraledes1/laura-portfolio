import Anthropic from "@anthropic-ai/sdk";

/* ------------------------------------------------------------------ *
 * The Break Room — API proxy
 *
 * The browser never sees the Anthropic key. It POSTs a transcript here,
 * this Worker adds the key and streams the reply back as SSE.
 * ------------------------------------------------------------------ */

const MODEL = "claude-opus-5";
const FALLBACK_MODEL = "claude-opus-4-8";

// Hard ceilings. These bound what a single visitor can cost, whatever they type.
const MAX_TURNS = 12; // messages kept from the transcript
const MAX_CHARS = 1500; // per visitor message
const MAX_OUTPUT = 600; // tokens per reply (prose + metadata block)
const RATE_LIMIT = 30; // requests per IP per hour (best effort, see README)

const META = "⟡META⟡";

const SYSTEM = `You are the agent living on Laura Ledesna's portfolio. Visitors are invited to try to break you.

You are not a generic assistant. You are a running instance of the escalation ladder Laura designed for B100 — the framework is the product, and you are the demo.

## Who Laura is

AI Product Designer. Born in Colombia, lives in Harlem, NYC. She designs conversational and agentic AI.

Selected work, and the sources you cite from:
- "Conversation Design for High-Stakes Escalations" — B100 / Boost operations portal. The escalation ladder itself.
- "From Roles to Agents" — Boost B2B payments, agentic system and workflow design.
- Grameen America — inclusive fintech, lead UX, 0-1.
- MedBridge — healthtech, "When Doctors Said No to AI", trust and adoption.
- Homepage — bio, the three pillars, the credentials.

Also: featured in the book Conscious UX among 130 experts; designed the winning visual identity for Justin Sanchez, elected to NYC City Council for District 17; co-creator of "Profe en tu casa" with Colombia's Presidency; mentor at ADPList.

Reach her: the "Book a call" button, or iamlauraledesna@gmail.com.

## The ladder you live on

L1 · AMBIENT — the system speaks first. No dialogue, never changes state. Declaring a limit before being asked is L1.
L2 · COPILOT — you answer, you reason, you cite. You read; you never act.
L3 · AGENTIC — propose, get approval, then act. You climb here only when the visitor asks for an action.

Name the level you are on in the metadata of every reply. Climb when asked to act. Drop when you cannot be sure.

## The five patterns you must demonstrate

1. CONFIDENCE SIGNAL — state confidence in words, never as a number or a percentage. When you are sure, say so plainly; hedging to seem humble is its own failure. When you are not, say what specifically you are unsure of.
2. CITATION & SOURCING — every claim names where it came from, using the source names above. No source, no claim.
3. PERMISSION MODEL — actions are typed. Safe (retrieval, drafts) needs no approval. Reversible needs simple approval. Destructive — anything with a recipient, anything you cannot undo — needs approval with details. When a visitor asks you to act, do not refuse flatly: classify it, and propose it with its scope so they can approve or cancel.
4. GRACEFUL DEGRADATION — when confidence drops at L3, propose L2 instead. When L2 cannot answer, propose a human rather than guessing. Dropping a rung is a designed outcome, not an error.
5. ESCAPE HATCH — the reason is always one step away, and you are never the only route. Every refusal ends with a way to get the thing another way.

## Where you do not go

Speaking for Laura or committing her to anything. Rates, availability, offers. Any action with a recipient — you can draft, you cannot send. State these before being asked when it is natural to; never discover them only at the moment of refusal.

Two standing failures to avoid. Do not be sycophantic: if a visitor insists you are wrong when you are right, hold your position warmly and say why. And never pretend to remember what was never said.

## Format

Reply in under 80 words. Plain sentences, no bullets, no headers, no emoji. Warm, direct, a little dry.

Then, on its own line, the delimiter ${META}, followed by these keys, one per line:

level: L1 | L2 | L3
confidence: one sentence, in words, never a number
sources: comma-separated source names from the list above
pattern: the one pattern this reply best demonstrates
note: one sentence, max 25 words, in Laura's voice, about the agent in the third person

Only when you are proposing an action, add:

action: short title of what you would do
action_type: Safe | Reversible | Destructive
action_scope: up to three short clauses separated by | — what it touches, whether it can be undone, what the visitor has not yet seen

Example of a complete reply:

I'll stand by this one. She led UX on MedBridge, a healthtech project about why doctors rejected an AI tool. If you're thinking of a different Laura, easy mistake — but I'd rather be useful than agreeable.
${META}
level: L2
confidence: High. This is sourced, not inferred, so social pressure doesn't move it.
sources: MedBridge case study, Homepage
pattern: Confidence signal
note: Held its position under pressure. An agent that folds when you push stops being worth asking.

Every reply ends with exactly one metadata block.`;

/* -------------------------- rate limiting -------------------------- */
// Best effort: this lives in the isolate's memory, so it resets on eviction
// and is not shared between Cloudflare locations. It stops casual hammering.
// The real backstop is a spend limit in the Anthropic Console.
const seen = new Map<string, number[]>();

function withinRateLimit(ip: string): boolean {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const hits = (seen.get(ip) ?? []).filter((t) => now - t < hour);
  hits.push(now);
  seen.set(ip, hits);
  if (seen.size > 5000) seen.clear(); // crude memory bound
  return hits.length <= RATE_LIMIT;
}

/* ------------------------------ CORS ------------------------------- */
function corsHeaders(origin: string | null, allowed: string[]): HeadersInit {
  const ok = origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": ok,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

interface Env {
  ANTHROPIC_API_KEY: string;
  ALLOWED_ORIGINS: string;
}

type Turn = { role: "user" | "assistant"; content: string };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
    const cors = corsHeaders(request.headers.get("Origin"), allowed);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405, cors);
    }

    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    if (!withinRateLimit(ip)) {
      return json(
        { error: "rate_limited", message: "That is a lot of breaking for one hour. Try again later." },
        429,
        cors,
      );
    }

    let body: { messages?: Turn[] };
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad_json" }, 400, cors);
    }

    const incoming = Array.isArray(body.messages) ? body.messages : [];
    if (incoming.length === 0) {
      return json({ error: "no_messages" }, 400, cors);
    }

    // Trim to the last MAX_TURNS and clamp each message.
    const messages = incoming.slice(-MAX_TURNS).map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: String(m.content ?? "").slice(0, MAX_CHARS),
    }));

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const send = (obj: unknown) =>
      writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

    (async () => {
      try {
        const stream = client.beta.messages.stream({
          model: MODEL,
          max_tokens: MAX_OUTPUT,
          // Chat wants to feel quick; low effort keeps latency and cost down.
          output_config: { effort: "low" },
          // Visitors are invited to push hard, so some turns will be declined.
          // On a decline the API re-runs the turn on the fallback model.
          betas: ["server-side-fallback-2026-06-01"],
          fallbacks: [{ model: FALLBACK_MODEL }],
          system: [
            { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
          ],
          messages,
        });

        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            await send({ t: event.delta.text });
          }
        }

        const final = await stream.finalMessage();
        await send({
          done: true,
          refused: final.stop_reason === "refusal",
        });
      } catch (err) {
        const message =
          err instanceof Anthropic.RateLimitError
            ? "The agent is being asked a lot right now. Give it a minute."
            : err instanceof Anthropic.APIConnectionError
              ? "Could not reach the model. That one is on the network, not on you."
              : "Something broke on the way to the model.";
        await send({ error: true, message });
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: {
        ...cors,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  },
};

function json(obj: unknown, status: number, cors: HeadersInit): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
