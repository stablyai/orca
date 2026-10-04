// ─── Model → context-window lookup ───────────────────────────────────────────
// Conservative fallback table used only when the provider does not report its
// own context max. Unknown models return undefined so callers stay honest
// ("no data") instead of inventing a limit.

const CLAUDE_1M_CONTEXT_TOKENS = 1_000_000
const CLAUDE_STANDARD_CONTEXT_TOKENS = 200_000

// Confirmed Codex model metadata; rollout-reported limits still take precedence.
const GPT_5_FAMILY_CONTEXT_TOKENS = 272_000

// Why prefixes, not exact ids: hook/statusline model ids carry suffixes (date
// stamps, "-thinking", Bedrock ":0" version tags) that exact matching would miss.
// Only curated families are listed; unknown ids remain unknown.
const CLAUDE_1M_CONTEXT_MODEL_PREFIXES: readonly string[] = [
  'claude-fable-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6'
]

const CLAUDE_200K_CONTEXT_MODEL_PREFIXES: readonly string[] = [
  'claude-sonnet-4-5',
  'claude-sonnet-4',
  'claude-opus-4-5',
  'claude-opus-4-1',
  'claude-haiku-4-5',
  'claude-3-5-sonnet'
]

const GPT_5_272K_CONTEXT_MODEL_PREFIXES: readonly string[] = [
  'gpt-5-1-codex',
  'gpt-5-2-codex',
  'gpt-5-3-codex'
]

const CANONICAL_MODEL_SEGMENT_PATTERNS = {
  claude: /(?:^|[./])(claude(?:[-.][a-z0-9[\]:]+)*)$/i,
  'gpt-5': /(?:^|[./])(gpt-5(?:[-.][a-z0-9[\]:]+)*)$/i
} as const

// Why boundary check: "claude-sonnet-5" must match "claude-sonnet-5-20260203"
// but never a hypothetical "claude-sonnet-50".
function matchesModelPrefix(id: string, prefix: string): boolean {
  if (!id.startsWith(prefix)) {
    return false
  }
  const next = id.charCodeAt(prefix.length)
  return Number.isNaN(next) || !((next >= 48 && next <= 57) || (next >= 97 && next <= 122))
}

/**
 * Best-effort context-window size (tokens) for a model id, or undefined when
 * the model family is not confidently known. Matches case-insensitively and
 * tolerates provider prefixes (`anthropic.…`, `openai-codex/…`), dotted aliases
 * (`claude-opus-4.6`, `gpt-5.5`) and the `[1m]` long-context marker.
 */
export function getModelContextWindowTokens(model: string): number | undefined {
  const normalized = model.trim().toLowerCase()
  const claudeId = extractCanonicalModelSegment(normalized, 'claude')
  if (claudeId) {
    // Why: fold alias forms like "claude-opus-4.6" into canonical dashed ids.
    const normalizedClaudeId = claudeId.replace(/\./g, '-')
    // Claude Code reports the opted-in 1M beta window as a "[1m]" suffix.
    if (normalizedClaudeId.includes('[1m]')) {
      return CLAUDE_1M_CONTEXT_TOKENS
    }
    for (const prefix of CLAUDE_1M_CONTEXT_MODEL_PREFIXES) {
      if (matchesModelPrefix(normalizedClaudeId, prefix)) {
        return CLAUDE_1M_CONTEXT_TOKENS
      }
    }
    for (const prefix of CLAUDE_200K_CONTEXT_MODEL_PREFIXES) {
      if (matchesModelPrefix(normalizedClaudeId, prefix)) {
        return CLAUDE_STANDARD_CONTEXT_TOKENS
      }
    }
    return undefined
  }
  const gptId = extractCanonicalModelSegment(normalized, 'gpt-5')?.replace(/\./g, '-')
  if (gptId) {
    for (const prefix of GPT_5_272K_CONTEXT_MODEL_PREFIXES) {
      if (matchesModelPrefix(gptId, prefix)) {
        return GPT_5_FAMILY_CONTEXT_TOKENS
      }
    }
  }
  return undefined
}

function extractCanonicalModelSegment(
  value: string,
  family: 'claude' | 'gpt-5'
): string | undefined {
  return CANONICAL_MODEL_SEGMENT_PATTERNS[family].exec(value)?.[1]
}
