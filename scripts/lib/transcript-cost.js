'use strict';

// Minimal transcript cost estimate for the agent-loop budget check.
//
// Mirrors the parsing + pricing rules in the Rust CLI (src/session.rs,
// src/pricing.rs) and the web dashboard (lib/analyze-transcript.ts,
// lib/pricing.ts): only `type === "assistant"` lines count, and per-model
// pricing falls back to a substring match (opus / haiku / else sonnet)
// rather than an exact model-id table.
//
// Claude Code writes one JSONL record per content block of a response,
// repeating that whole response's `usage` in each record — a turn that
// thinks and then makes two tool calls appears three times. Counting every
// occurrence inflates every token/cost figure by roughly 90% on real
// transcripts, so records are deduped by `message.id` (falling back to
// counting when no id is present, since that's a genuine response, not a
// duplicate — silently dropping it would undercount instead).

const fs = require('fs');

const SONNET_PRICING = { in: 3, out: 15, cw: 3.75, cr: 0.3 };
const OPUS_PRICING = { in: 15, out: 75, cw: 18.75, cr: 1.5 };
const HAIKU_PRICING = { in: 0.8, out: 4, cw: 1.0, cr: 0.08 };

function pricingFor(model) {
  const lower = String(model || '').toLowerCase();
  if (lower.includes('opus')) return OPUS_PRICING;
  if (lower.includes('haiku')) return HAIKU_PRICING;
  return SONNET_PRICING;
}

/// Reads and costs a Claude Code transcript file synchronously, returning
/// `{ costUsd, turns }`. Never throws — a missing/unreadable/malformed
/// transcript just yields zero cost, since the budget check must degrade to
/// "no data" rather than fail the hook.
function costTranscriptSync(transcriptPath) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return { costUsd: 0, turns: 0 };
  }
  return costTranscriptText(raw);
}

function costTranscriptText(raw) {
  const countedResponses = new Set();
  let turns = 0;
  let cost = 0;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object' || record.type !== 'assistant') continue;

    const msg = record.message;
    if (!msg || typeof msg !== 'object') continue;

    const usage = msg.usage;
    const responseId = typeof msg.id === 'string' ? msg.id : null;
    const alreadyCounted = responseId !== null && countedResponses.has(responseId);
    if (usage && !alreadyCounted) {
      if (responseId !== null) countedResponses.add(responseId);
      turns++;

      const inp = Number(usage.input_tokens) || 0;
      const out = Number(usage.output_tokens) || 0;
      const cw = Number(usage.cache_creation_input_tokens) || 0;
      const cr = Number(usage.cache_read_input_tokens) || 0;

      const p = pricingFor(msg.model);
      cost += (inp * p.in + out * p.out + cw * p.cw + cr * p.cr) / 1_000_000;
    }
  }

  return { costUsd: cost, turns };
}

module.exports = { costTranscriptSync, costTranscriptText, pricingFor };
