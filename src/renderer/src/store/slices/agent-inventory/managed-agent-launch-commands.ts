import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { ManagedAgentCommands } from '../../../../../shared/agent-launch/startup/managed-agent-launch-program'

// Host facts launches read synchronously, kept out of Zustand: one entry per host, never per
// workspace, so the map is bounded by the paired hosts and drops with them.
const byHost = new Map<string, { started: number; commands: ManagedAgentCommands }>()
const listeners = new Set<() => void>()
let lastStarted = 0

export const LOCAL_MANAGED_AGENT_HOST = 'local'

export function runtimeManagedAgentHost(environmentId: string): string {
  return `runtime:${environmentId}`
}

/** A host's detection reply: older hosts answer the agent list alone, and a WSL guest reports no
 *  paths (Orca's copies live on the host). */
export type AgentDetectionReply =
  | readonly string[]
  | { agents: readonly string[]; managedAgentCommands?: Record<string, string> }

export type AgentDetectionReading = {
  agents: TuiAgent[]
  /** Called once the reply is current; a reply started before the one already kept is dropped. */
  keepManagedAgentCommands: () => void
}

/** Starts a detection on `host`; its reader yields the agents and, when kept, the paths. */
export function beginAgentDetection(
  host: string
): (reply: AgentDetectionReply) => AgentDetectionReading {
  const started = ++lastStarted
  return (reply) => {
    const paths = 'agents' in reply ? reply.managedAgentCommands : undefined
    return {
      agents: ('agents' in reply ? reply.agents : reply).filter(isTuiAgent),
      keepManagedAgentCommands: () => {
        if (paths && started > (byHost.get(host)?.started ?? 0)) {
          byHost.set(host, { started, commands: typedCommands(paths) })
          listeners.forEach((listener) => listener())
        }
      }
    }
  }
}

/** One detection's reader for promise chains: `read` maps a reply to agents, `keep` keeps its paths. */
export function agentDetectionReader(host: string): {
  read: (reply: AgentDetectionReply) => TuiAgent[]
  keep: () => void
} {
  const begin = beginAgentDetection(host)
  let reading: AgentDetectionReading | null = null
  return {
    read: (reply) => {
      reading = begin(reply)
      return reading.agents
    },
    keep: () => reading?.keepManagedAgentCommands()
  }
}

function typedCommands(paths: Record<string, string>): ManagedAgentCommands {
  const typed: ManagedAgentCommands = {}
  for (const [agent, path] of Object.entries(paths)) {
    if (isTuiAgent(agent) && typeof path === 'string' && path.length > 0) {
      typed[agent] = path
    }
  }
  return typed
}

export function readManagedAgentCommands(host: string): ManagedAgentCommands | undefined {
  return byHost.get(host)?.commands
}

export function forgetManagedAgentCommands(drop: (host: string) => boolean): void {
  for (const host of [...byHost.keys()].filter(drop)) {
    byHost.delete(host)
  }
  listeners.forEach((listener) => listener())
}

export function forgetRuntimeManagedAgentCommands(drop: (environmentId: string) => boolean): void {
  const prefix = runtimeManagedAgentHost('')
  forgetManagedAgentCommands((host) => host.startsWith(prefix) && drop(host.slice(prefix.length)))
}

export function subscribeManagedAgentCommands(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
