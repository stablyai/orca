import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'

const AGENT_SETTINGS_ROW_PREFIX = 'settings-agent-'
export const AGENT_SETTINGS_TARGET_WAIT_MS = 30_000

/** An agent's row, or an agent copy's row by its copy id. */
export function getAgentSettingsRowId(agent: TuiAgent | string): string {
  return `${AGENT_SETTINGS_ROW_PREFIX}${agent}`
}

export function isAgentSettingsRowId(target: string): boolean {
  return target.startsWith(AGENT_SETTINGS_ROW_PREFIX)
}

export function agentSettingsInventoryState(root: ParentNode): 'pending' | 'ready' | 'failed' {
  const inventory = root.querySelector<HTMLElement>('[data-agent-inventory-state]')?.dataset
    .agentInventoryState
  if (inventory === 'ready' || inventory === 'failed') {
    return inventory
  }
  const settings = root.querySelector<HTMLElement>('[data-agent-settings-state]')?.dataset
    .agentSettingsState
  return settings === 'failed' || settings === 'unsupported' ? 'failed' : 'pending'
}
