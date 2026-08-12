export type JiraSummaryLookupErrorCode = 'disconnected' | 'auth' | 'not-found' | 'read-failed'

const ERROR_PREFIX = 'jira_summary_lookup:'

export class JiraSummaryLookupError extends Error {
  code: JiraSummaryLookupErrorCode

  constructor(code: JiraSummaryLookupErrorCode, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
    super(`${ERROR_PREFIX}${code}${detail ? `:${detail}` : ''}`)
    this.name = 'JiraSummaryLookupError'
    this.code = code
  }
}

export function getJiraSummaryLookupErrorCode(error: unknown): JiraSummaryLookupErrorCode | null {
  if (
    error instanceof JiraSummaryLookupError ||
    (error && typeof error === 'object' && 'code' in error)
  ) {
    const code = (error as { code?: unknown }).code
    if (
      code === 'disconnected' ||
      code === 'auth' ||
      code === 'not-found' ||
      code === 'read-failed'
    ) {
      return code
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  const match = message.match(/jira_summary_lookup:(disconnected|auth|not-found|read-failed)/)
  return (match?.[1] as JiraSummaryLookupErrorCode | undefined) ?? null
}
