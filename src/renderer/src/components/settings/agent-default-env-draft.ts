import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'
import { tokenizeCustomCommandTemplate } from '../../../../shared/commit-message-prompt'
import { quotePosixShellDoubleQuotedApostrophe } from '../../../../shared/shell-argument-quoting'

// Reject oversized pasted overrides before tokenization.
export const AGENT_DEFAULT_ENV_DRAFT_MAX_BYTES = 8 * 1024

export type AgentDefaultEnvDraftInvalidReason = 'too-large' | 'unclosed-quote'

export type AgentDefaultEnvDraftParseResult = {
  env: Record<string, string>
  invalidReason: AgentDefaultEnvDraftInvalidReason | null
}

export function stringifyAgentDefaultEnvDraft(env: Record<string, string>): string {
  return Object.entries(env)
    .map(
      ([name, value]) =>
        `${quoteAgentDefaultEnvDraftWord(name)}=${quoteAgentDefaultEnvDraftWord(value)}`
    )
    .join(' ')
}

// Use quote grouping that preserves literal backslashes without introducing escapes.
function quoteAgentDefaultEnvDraftWord(word: string): string {
  return word && !/[\s'"]/.test(word) ? word : quotePosixShellDoubleQuotedApostrophe(word)
}

export function parseAgentDefaultEnvDraft(value: string): AgentDefaultEnvDraftParseResult {
  if (isClipboardTextByteLengthOverLimit(value, AGENT_DEFAULT_ENV_DRAFT_MAX_BYTES)) {
    return { env: {}, invalidReason: 'too-large' }
  }
  // Preserve unquoted Windows path separators as literal backslashes.
  const tokenized = tokenizeCustomCommandTemplate(value, 'literal')
  if (!tokenized.ok) {
    return { env: {}, invalidReason: 'unclosed-quote' }
  }

  const env: Record<string, string> = {}
  for (const pair of tokenized.tokens) {
    const separatorIndex = pair.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }
    env[pair.slice(0, separatorIndex)] = pair.slice(separatorIndex + 1)
  }
  return { env, invalidReason: null }
}
