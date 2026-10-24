import type { GlobalSettings } from '../../../../shared/global-settings-types'

export type TerminalLinkClickBehavior = 'actions' | 'open' | 'none'

/** Resolves the new preference while keeping older profiles behaviorally identical. */
export function terminalLinkClickBehaviorFor(
  settings:
    | Pick<GlobalSettings, 'terminalLinkClickBehavior' | 'terminalLinkActionPopoverEnabled'>
    | null
    | undefined
): TerminalLinkClickBehavior {
  const behavior = settings?.terminalLinkClickBehavior
  if (behavior === 'actions' || behavior === 'open' || behavior === 'none') {
    return behavior
  }
  return settings?.terminalLinkActionPopoverEnabled === false ? 'none' : 'actions'
}
