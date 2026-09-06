export const TERMINAL_TAB_MOUNT_INTENTS = ['client-subscribe', 'inbound-message'] as const

/**
 * Who asked for a terminal tab to be background-mounted: a client subscribing to
 * the terminal (a person opening it), or orchestration mail arriving for a pane
 * with no process. Opening a terminal is the documented way to wake a
 * deliberately slept pane, so only an inbound message may be refused for one.
 */
export type TerminalTabMountIntent = (typeof TERMINAL_TAB_MOUNT_INTENTS)[number]

/**
 * Why: the field is additive on an existing request, so a caller that predates it
 * sends nothing. Absent must keep today's permissive behavior or the mobile
 * subscribe path silently loses its mount.
 */
export function isInboundMessageTabMount(intent: TerminalTabMountIntent | undefined): boolean {
  return intent === 'inbound-message'
}
