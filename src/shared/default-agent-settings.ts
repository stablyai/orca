import type { GlobalSettings } from './global-settings-types'
import type { TuiAgent } from './tui-agent'

type DefaultAgentSettings = Pick<GlobalSettings, 'defaultTuiAgent' | 'newWorkspaceSetupOnly'>

export function buildDefaultAgentSettingsUpdate(
  next: TuiAgent | 'blank' | null
): DefaultAgentSettings {
  // Clear the retired flag so older peers also see a regular agent or shell default.
  return { defaultTuiAgent: next, newWorkspaceSetupOnly: false }
}
