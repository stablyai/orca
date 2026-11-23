/** Claude Code reads this at start; set, a flagged request ends the turn instead of re-running on a fallback model. */
export const CLAUDE_REFUSAL_FALLBACK_OFF_ENV = 'CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK'

export const CLAUDE_FLAGGED_REQUEST_ACTIONS = ['switch-model', 'stop'] as const
export type ClaudeFlaggedRequestAction = (typeof CLAUDE_FLAGGED_REQUEST_ACTIONS)[number]

/** An absent or unknown value (an older or hand-edited profile) is Claude's own default. */
export function claudeFlaggedRequestAction(
  settings: { readonly claudeFlaggedRequestAction?: unknown } | null | undefined
): ClaudeFlaggedRequestAction {
  return settings?.claudeFlaggedRequestAction === 'stop' ? 'stop' : 'switch-model'
}

/** What a Claude launch on this host adds for the choice; the default adds nothing. */
export function claudeFlaggedRequestEnv(
  settings: { readonly claudeFlaggedRequestAction?: unknown } | null | undefined
): Record<string, string> {
  return claudeFlaggedRequestAction(settings) === 'stop'
    ? { [CLAUDE_REFUSAL_FALLBACK_OFF_ENV]: '1' }
    : {}
}

/** Whether a launch's env turns the switch off, read the way Claude Code reads it. */
export function claudeEnvStopsOnFlaggedRequest(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform
): boolean {
  const value = Object.entries(env).find(([key]) =>
    platform === 'win32'
      ? key.toUpperCase() === CLAUDE_REFUSAL_FALLBACK_OFF_ENV
      : key === CLAUDE_REFUSAL_FALLBACK_OFF_ENV
  )?.[1]
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '')
}
