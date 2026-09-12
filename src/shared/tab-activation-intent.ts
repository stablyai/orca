export const TAB_ACTIVATION_INTENTS = ['user', 'automatic'] as const

/**
 * Who asked for a tab activation: an explicit user gesture (opening the tab) or
 * background machinery (a reconnect/recovery probe). Opening a tab is the
 * documented way to wake a deliberately slept pane, so only an automatic
 * activation may be refused for one.
 */
export type TabActivationIntent = (typeof TAB_ACTIVATION_INTENTS)[number]

/**
 * Why: the field is additive on an existing method, so a client that predates it
 * sends nothing. Absent must keep today's permissive behavior or those clients
 * silently lose their wake gesture.
 */
export function isAutomaticTabActivation(intent: TabActivationIntent | undefined): boolean {
  return intent === 'automatic'
}
