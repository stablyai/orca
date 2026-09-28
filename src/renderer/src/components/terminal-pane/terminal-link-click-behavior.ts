import type { GlobalSettings } from '../../../../shared/global-settings-types'

export type TerminalLinkClickBehavior = 'actions' | 'open' | 'none'

/** Resolves the new preference while keeping older profiles behaviorally identical. */
export function terminalLinkClickBehaviorFor(
  settings:
    | Pick<GlobalSettings, 'terminalLinkClickBehavior' | 'terminalLinkActionPopoverEnabled'>
    | null
    | undefined
): TerminalLinkClickBehavior {
  if (settings?.terminalLinkClickBehavior === 'open') {
    return 'open'
  }
  if (settings?.terminalLinkClickBehavior === 'none') {
    return 'none'
  }
  return settings?.terminalLinkActionPopoverEnabled === false ? 'none' : 'actions'
}
