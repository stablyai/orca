import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { ManagedAgentCommands } from '../../../../../shared/agent-launch/startup/managed-agent-launch-program'

// Host facts launches read synchronously, kept out of Zustand: one entry per host, never per
// workspace, so the map is bounded by the paired hosts and drops with them.
const byHost = new Map<string, { started: number; commands: ManagedAgentCommands }>()
const listeners = new Set<() => void>()
const incompleteInventories = new WeakMap<TuiAgent[], number | undefined>()
let lastStarted = 0

export const LOCAL_MANAGED_AGENT_HOST = 'local'

export function runtimeManagedAgentHost(environmentId: string): string {
  return `runtime:${environmentId}`
}

/** Older hosts can report the agent list alone, or mix managed copies into their CLI paths. */
export type AgentDetectionReply =
  | readonly string[]
  | {
      agents: readonly string[]
      incomplete?: boolean
      afterPublication?: number
      outsidePath?: Record<string, string>
      managedAgentCommands?: Record<string, string>
    }

export type AgentDetectionReading = {
  agents: TuiAgent[]
  incomplete: boolean
  afterPublication?: number
  /** Called once the reply is current; a reply started before the one already kept is dropped. */
  keepManagedAgentCommands: () => void
}

/** Starts a detection on `host`; its reader yields the agents and, when kept, the paths. */
export function beginAgentDetection(
  host: string
): (reply: AgentDetectionReply) => AgentDetectionReading {
  const started = ++lastStarted
  return (reply) => {
    // Legacy replies don't identify the host's data root, so their paths may be user installs.
    const paths = 'agents' in reply ? (reply.outsidePath ?? reply.managedAgentCommands) : undefined
    const incomplete = 'agents' in reply && reply.incomplete === true
    return {
      agents: ('agents' in reply ? reply.agents : reply).filter(isTuiAgent),
      incomplete,
      afterPublication: incomplete ? reply.afterPublication : undefined,
      keepManagedAgentCommands: () => {
        const kept = byHost.get(host)
        if (!paths || started <= (kept?.started ?? 0)) {
          return
        }
        const found = typedCommands(paths)
        const commands = incomplete ? { ...kept?.commands, ...found } : found
        const changed = !kept || !sameCommands(kept.commands, commands)
        // An unchanged reply keeps the same object, so readers see no change.
        byHost.set(host, { started, commands: changed ? commands : kept.commands })
        if (changed) {
          listeners.forEach((listener) => listener())
        }
      }
    }
  }
}

export function mergeAgentDetection(
  {
    agents,
    incomplete,
    afterPublication
  }: Pick<AgentDetectionReading, 'agents' | 'incomplete' | 'afterPublication'>,
  previous: TuiAgent[] | null | undefined
): TuiAgent[] {
  if (!incomplete) {
    return agents
  }
  const merged = [...new Set([...(previous ?? []), ...agents])]
  incompleteInventories.set(merged, afterPublication)
  return merged
}

export function isIncompleteAgentInventory(agents: TuiAgent[] | null | undefined): boolean {
  return !!agents && incompleteInventories.has(agents)
}

export function agentInventoryRetryParams(agents: TuiAgent[] | null | undefined): {
  afterPublication?: number
} {
  const afterPublication = agents ? incompleteInventories.get(agents) : undefined
  return afterPublication === undefined ? {} : { afterPublication }
}

function sameCommands(a: ManagedAgentCommands, b: ManagedAgentCommands): boolean {
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((agent) => isTuiAgent(agent) && a[agent] === b[agent])
  )
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
  const dropped = [...byHost.keys()].filter(drop)
  dropped.forEach((host) => byHost.delete(host))
  if (dropped.length > 0) {
    listeners.forEach((listener) => listener())
  }
}

export function forgetRuntimeManagedAgentCommands(drop: (environmentId: string) => boolean): void {
  const prefix = runtimeManagedAgentHost('')
  forgetManagedAgentCommands((host) => host.startsWith(prefix) && drop(host.slice(prefix.length)))
}

export function subscribeManagedAgentCommands(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
