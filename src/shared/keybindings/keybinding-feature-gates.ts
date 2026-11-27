import type { GlobalSettings } from '../settings/global-settings-types'
import type { KeybindingActionId } from './types'

const NO_UNAVAILABLE_ACTIONS: readonly KeybindingActionId[] = []
const AGENT_DASHBOARD_OFF: readonly KeybindingActionId[] = ['dashboard.toggle']

/** Actions whose feature is switched off: their saved chords stay stored but must not claim keys. */
export function getUnavailableKeybindingActionIds(
  settings: Pick<GlobalSettings, 'experimentalAgentDashboardPopout'> | null | undefined
): readonly KeybindingActionId[] {
  return settings?.experimentalAgentDashboardPopout === true
    ? NO_UNAVAILABLE_ACTIONS
    : AGENT_DASHBOARD_OFF
}
