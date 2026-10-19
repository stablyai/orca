import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { buildAgentAvailabilitySettingsUpdate } from '../../../../shared/tui-agent-selection'

export { buildAgentAvailabilitySettingsUpdate }

export type AgentAvailabilityUpdateQueueOptions = {
  getSettings: () => GlobalSettings | null | undefined
  fallbackSettings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  agentId: TuiAgent
  enabled: boolean
}

export function createAgentSettingsUpdateQueue(): (
  options: Pick<
    AgentAvailabilityUpdateQueueOptions,
    'getSettings' | 'fallbackSettings' | 'updateSettings'
  > & {
    buildUpdate: (settings: GlobalSettings) => Partial<GlobalSettings>
  }
) => Promise<void> {
  let pendingUpdate: Promise<unknown> = Promise.resolve()
  return ({ getSettings, fallbackSettings, updateSettings, buildUpdate }) => {
    // Serialize replacement writes against the reconciled store.
    pendingUpdate = pendingUpdate
      .catch(() => {})
      .then(() => updateSettings(buildUpdate(getSettings() ?? fallbackSettings)))
    return pendingUpdate.then(() => undefined)
  }
}

export function createAgentAvailabilityUpdateQueue(): (
  options: AgentAvailabilityUpdateQueueOptions
) => Promise<void> {
  const enqueue = createAgentSettingsUpdateQueue()
  return ({ agentId, enabled, ...options }) =>
    enqueue({
      ...options,
      buildUpdate: (settings) => buildAgentAvailabilitySettingsUpdate(settings, agentId, enabled)
    })
}
