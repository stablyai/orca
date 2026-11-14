export const THEME_STUDIO_ERROR_CODES = {
  invalid: 'theme_invalid',
  noDraft: 'theme_no_draft',
  historyEnd: 'theme_history_end',
  needsDesktop: 'theme_needs_desktop',
  disabled: 'theme_edits_disabled',
  rateLimited: 'rate_limited',
  conflict: 'draft_conflict',
  endedByUser: 'draft_ended_by_user'
} as const

/** A theme edit refusal whose `data` carries `nextSteps` for the caller. */
export class ThemeStudioError extends Error {
  readonly code: string
  readonly data: { nextSteps: string[] } & Record<string, unknown>

  constructor(
    code: string,
    message: string,
    data: { nextSteps: string[] } & Record<string, unknown>
  ) {
    super(message)
    this.name = 'ThemeStudioError'
    this.code = code
    this.data = data
  }
}
