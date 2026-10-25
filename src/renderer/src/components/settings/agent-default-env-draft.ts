import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'
import { tokenizeCustomCommandTemplate } from '../../../../shared/commit-message-prompt'
import { quotePosixShellDoubleQuotedApostrophe } from '../../../../shared/shell-argument-quoting'

// Why: environment overrides are pasteable settings text; reject huge drafts before tokenizing.
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

// Why: the parser groups quotes with literal backslashes, so this spelling never needs a backslash.
function quoteAgentDefaultEnvDraftWord(word: string): string {
  return word && !/[\s'"]/.test(word) ? word : quotePosixShellDoubleQuotedApostrophe(word)
}

export function parseAgentDefaultEnvDraft(value: string): AgentDefaultEnvDraftParseResult {
  if (isClipboardTextByteLengthOverLimit(value, AGENT_DEFAULT_ENV_DRAFT_MAX_BYTES)) {
    return { env: {}, invalidReason: 'too-large' }
  }
  // Why literal backslashes: Windows paths typed without quotes must keep their separators.
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
