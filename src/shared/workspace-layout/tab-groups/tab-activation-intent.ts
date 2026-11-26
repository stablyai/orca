export const TAB_ACTIVATION_INTENTS = ['user', 'automatic'] as const

/** Explicit tab opening wakes slept panes; only background activation may be refused. */
export type TabActivationIntent = (typeof TAB_ACTIVATION_INTENTS)[number]

/** Old clients omit the additive field; preserve their permissive wake gesture. */
export function isAutomaticTabActivation(intent: TabActivationIntent | undefined): boolean {
  return intent === 'automatic'
}
