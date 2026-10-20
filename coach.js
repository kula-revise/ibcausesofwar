// The coach function. The workshop page posts here; this adds the API key
// (kept in Vercel, never in the page) and passes the request to Claude.

const MODELS = {
  quick: process.env.MODEL_QUICK || "claude-haiku-5-5",     // coach panel answers
  default: process.env.MODEL_DEFAULT || "claude-sonnet-5-5" // reads of written parts
};
const MAX_TOKENS = { quick: 700, default: 1500 };
const MAX_INPUT = 90000;            // characters: brief + fact bank + student's words
const CALLS_PER_TEN_MINUTES = 30;   // per visitor, best effort

const seen = new Map();
function tooMany(ip) {
  const now = Date.now();
  const list = (seen.get(ip) || []).filter(t => now - t < 600000);
  if (list.length >= CALLS_PER_TEN_MINUTES) { seen.set(ip, list); return true; }
  list.push(now); seen.set(ip, list); return false;
}

function fail(res, status, code) { res.status(status).json({ code }); }

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return fail(res, 405, "method_not_allowed");

  // Only answer requests from your own site, once ALLOWED_ORIGIN is set.
  const allowed = process.env.ALLOWED_ORIGIN;
  if (allowed && req.headers.origin && req.headers.origin !== allowed) return fail(res, 403, "not_granted");

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (tooMany(ip)) return fail(res, 429, "rate_limited");

  const body = typeof req.body === "string" ? safeParse(req.body) : (req.body || {});
  const input = typeof body.input === "string" ? body.input : "";
  const tier = body.tier === "default" ? "default" : "quick";
  const json = body.json === true;
  if (!input.trim()) return fail(res, 400, "empty_completion");
  if (input.length > MAX_INPUT) return fail(res, 413, "too_long");

  const system = json
    ? "Reply with one JSON object only, exactly in the shape the brief asks for. No other text before or after it."
    : undefined;

  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODELS[tier],
        max_tokens: MAX_TOKENS[tier],
        ...(system ? { system } : {}),
        messages: [{ role: "user", content: input }]
      })
    });
  } catch (e) {
    return fail(res, 502, "upstream_error");
  }

  if (r.status === 429 || r.status === 529) return fail(res, 429, "rate_limited");
  if (!r.ok) {
    console.error("Anthropic error", r.status, await r.text().catch(() => ""));
    return fail(res, 502, "upstream_error");
  }

  const data = await r.json();
  if (data.stop_reason === "refusal") return fail(res, 422, "refused");
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  if (!text) return fail(res, 502, "empty_completion");

  if (json) {
    const start = text.indexOf("{"), end = text.lastIndexOf("}");
    const parsed = start >= 0 && end > start ? safeParse(text.slice(start, end + 1)) : null;
    if (!parsed) return fail(res, 502, "invalid_json");
    return res.status(200).json({ data: parsed, tier });
  }
  return res.status(200).json({ text, truncated: data.stop_reason === "max_tokens", tier });
};

function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
