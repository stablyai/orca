import type { GlobalSettings } from '../../settings/global-settings-types'
import type { TuiAgent } from '../catalog/tui-agent'

type DefaultAgentSettings = Pick<
  GlobalSettings,
  'defaultTuiAgent' | 'newWorkspaceSetupOnly' | 'defaultCustomAcpAgent'
>

export function buildDefaultAgentSettingsUpdate(
  next: TuiAgent | 'blank' | null
): DefaultAgentSettings {
  // Clear the retired flag so older peers also see a regular agent or shell default; any choice
  // made here replaces a custom ACP default.
  return { defaultTuiAgent: next, newWorkspaceSetupOnly: false, defaultCustomAcpAgent: null }
}
