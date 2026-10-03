export const CLAUDE_AUTH_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK'
] as const

/** Words that make ANTHROPIC_CUSTOM_HEADERS a credential; other headers keep reaching Claude. */
export const CLAUDE_AUTH_HEADER_WORDS = 'authorization|x-api-key|api-key|bearer'

/** The same rule as a case-insensitive POSIX `case` pattern. */
export const CLAUDE_AUTH_HEADER_POSIX_PATTERN = CLAUDE_AUTH_HEADER_WORDS.split('|')
  .map((word) => `*${word.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`)}*`)
  .join('|')

export function isAuthLikeClaudeCustomHeaders(value: string | undefined): boolean {
  return Boolean(value) && new RegExp(CLAUDE_AUTH_HEADER_WORDS, 'i').test(value ?? '')
}
