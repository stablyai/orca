import type { GlobalSettings } from '../../../../shared/global-settings-types'

export type TerminalLinkClickBehavior = 'actions' | 'open' | 'none'

export function terminalLinkClickBehaviorFor(
  settings: Pick<GlobalSettings, 'terminalLinkClickBehavior'> | null | undefined
): TerminalLinkClickBehavior {
  return settings?.terminalLinkClickBehavior ?? 'actions'
}
