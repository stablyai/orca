import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { ManagedAgentCommands } from '../../../../../shared/agent-launch/startup/managed-agent-launch-program'

// Launches read these synchronously; they're host facts, not UI state, so they stay out of Zustand.
const commandsByInventory = new Map<string, ManagedAgentCommands>()

export function localManagedAgentInventoryKey(contextKey: string): string {
  return `local:${contextKey}`
}

export function runtimeManagedAgentInventoryKey(runtimeInventoryKey: string): string {
  return `runtime:${runtimeInventoryKey}`
}

/** A host's detection reply: older hosts answer the agent list alone. */
export type AgentDetectionReply =
  | readonly string[]
  | { agents: readonly string[]; managedAgentCommands?: Record<string, string> }

/** The reply's agents; Orca's copy paths it reports are kept for that inventory's launches. */
export function readAgentDetectionReply(
  reply: AgentDetectionReply,
  inventoryKey: string
): TuiAgent[] {
  const agents = 'agents' in reply ? reply.agents : reply
  rememberManagedAgentCommands(
    inventoryKey,
    'agents' in reply ? reply.managedAgentCommands : undefined
  )
  return agents.filter(isTuiAgent)
}

function rememberManagedAgentCommands(
  inventoryKey: string,
  commands: Record<string, string> | undefined
): void {
  const typed: ManagedAgentCommands = {}
  for (const [agent, path] of Object.entries(commands ?? {})) {
    if (isTuiAgent(agent) && typeof path === 'string' && path.length > 0) {
      typed[agent] = path
    }
  }
  if (Object.keys(typed).length > 0) {
    commandsByInventory.set(inventoryKey, typed)
  } else {
    commandsByInventory.delete(inventoryKey)
  }
}

export function readManagedAgentCommands(inventoryKey: string): ManagedAgentCommands | undefined {
  return commandsByInventory.get(inventoryKey)
}

export function forgetManagedAgentCommands(
  prefix: 'local:' | 'runtime:',
  drop: (key: string) => boolean = () => true
): void {
  for (const key of commandsByInventory.keys()) {
    if (key.startsWith(prefix) && drop(key)) {
      commandsByInventory.delete(key)
    }
  }
}
