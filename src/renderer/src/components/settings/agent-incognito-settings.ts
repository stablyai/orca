import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { normalizeTerminalIncognitoAgents } from '../../../../shared/tui-agent-selection'

export type AgentIncognitoUpdateQueueOptions = {
  getSettings: () => GlobalSettings | null | undefined
  fallbackSettings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  agentId: TuiAgent
  incognito: boolean
}

export function buildAgentIncognitoSettingsUpdate(
  settings: Pick<GlobalSettings, 'terminalIncognitoAgents'>,
  id: TuiAgent,
  incognito: boolean
): Pick<GlobalSettings, 'terminalIncognitoAgents'> {
  const latest = normalizeTerminalIncognitoAgents(settings.terminalIncognitoAgents)
  const next = incognito
    ? latest.includes(id)
      ? latest
      : [...latest, id]
    : latest.filter((agent) => agent !== id)

  return { terminalIncognitoAgents: next }
}

export function createAgentIncognitoUpdateQueue(): (
  options: AgentIncognitoUpdateQueueOptions
) => Promise<void> {
  let pendingUpdate: Promise<unknown> = Promise.resolve()

  return ({ getSettings, fallbackSettings, updateSettings, agentId, incognito }) => {
    // Why: serialize full-array replacements so each write sees the reconciled store.
    pendingUpdate = pendingUpdate
      .catch(() => {})
      .then(() =>
        updateSettings(
          buildAgentIncognitoSettingsUpdate(getSettings() ?? fallbackSettings, agentId, incognito)
        )
      )
    return pendingUpdate.then(() => undefined)
  }
}
