import type { Tab, TuiAgent } from '../../../../shared/types'

/** Inputs that decide whether a tab may toggle into the native chat view.
 *  Kept as a plain shape (not the live store) so the decision stays pure and
 *  unit-testable; call sites resolve `launchAgent`/`hasDetectedAgent` from the
 *  terminal tab + agent-status before calling. */
export type NativeChatAvailabilityInput = {
  /** Feature flag: hidden unless enabled from Settings > Experimental. */
  experimentalNativeChatEnabled?: boolean
  contentType: Tab['contentType']
  /** The coding-agent Orca launched in this terminal, if any (from TerminalTab). */
  launchAgent?: TuiAgent | null
  /** True when a live agent-status entry exists for any pane of this tab — i.e.
   *  an agent was detected at runtime even though `launchAgent` was not set
   *  (manually-started agents, resumed sessions). */
  hasDetectedAgent?: boolean
  /** True when another trusted tab signal (for example the terminal title
   *  resolver) identifies the foreground as an agent before hooks arrive. */
  hasResolvedAgent?: boolean
  /** Already-chat tabs must always be allowed to toggle back to terminal, even
   *  if live hook state was lost during a dev/app restart. */
  isChatViewMode?: boolean
}

/** Native chat is a rendering of a coding-agent conversation, so the toggle is
 *  only meaningful on terminals that actually run an agent. Plain shells and
 *  non-terminal surfaces (editor, browser, …) never qualify. Eligibility is the
 *  union of the launch-time hint and live detection so the control appears both
 *  for Orca-launched agents and for agents the user started themselves. */
export function canToggleNativeChat(input: NativeChatAvailabilityInput): boolean {
  if (input.experimentalNativeChatEnabled !== true) {
    return false
  }
  if (input.contentType !== 'terminal') {
    return false
  }
  return (
    input.isChatViewMode === true ||
    Boolean(input.launchAgent) ||
    input.hasDetectedAgent === true ||
    input.hasResolvedAgent === true
  )
}
