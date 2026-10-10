import type { GlobalSettings } from './global-settings-types'
import type { TuiAgent } from './tui-agent'

type DefaultAgentSettings = Pick<GlobalSettings, 'defaultTuiAgent' | 'newWorkspaceSetupOnly'>

/** "None": no agent and no extra shell; the new workspace shows only its Setup tab. */
export function isNewWorkspaceSetupOnlyDefault(
  settings: Partial<DefaultAgentSettings> | null | undefined
): boolean {
  return settings?.defaultTuiAgent === 'blank' && settings.newWorkspaceSetupOnly === true
}

export function buildDefaultAgentSettingsUpdate(
  next: TuiAgent | 'blank' | 'setup-only' | null
): DefaultAgentSettings {
  // Why: persist "None" as 'blank' + flag so clients without the flag still open a blank terminal.
  return next === 'setup-only'
    ? { defaultTuiAgent: 'blank', newWorkspaceSetupOnly: true }
    : { defaultTuiAgent: next, newWorkspaceSetupOnly: false }
}
