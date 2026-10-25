import { z } from 'zod'
import type { AgentStatusEntry } from '../agent-status-types'
import {
  parseWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../worktree/host-qualified-identity'

const LiveAgentWorktreeStatusSchema = z.enum(['working', 'monitoring', 'permission'])

/** Host-observed activity that prevents sleeping; lost contact is unverifiable, never gone. */
const WorkspaceActivityFactsSchema = z.object({
  terminal: z.enum(['live', 'unverifiable']).nullable(),
  browser: z.boolean(),
  structuredChat: z.boolean(),
  /** The strongest fresh, unfinished agent. */
  agent: LiveAgentWorktreeStatusSchema.nullable()
})

/** Only workspaces with some activity are listed; an absent id has none. */
export const WorkspaceActivityFactsSnapshotSchema = z.object({
  revision: z.number(),
  facts: z.record(z.string(), WorkspaceActivityFactsSchema)
})

/** Server-owned activity; its clients add browser/chat tabs. */
export const HostReportedActivitySchema = WorkspaceActivityFactsSchema.pick({
  terminal: true,
  agent: true
})

export type LiveAgentWorktreeStatus = z.infer<typeof LiveAgentWorktreeStatusSchema>
export type WorkspaceActivityFacts = z.infer<typeof WorkspaceActivityFactsSchema>
export type WorkspaceTerminalLiveness = NonNullable<WorkspaceActivityFacts['terminal']>
export type WorkspaceActivityFactsSnapshot = z.infer<typeof WorkspaceActivityFactsSnapshotSchema>
export type HostReportedActivity = z.infer<typeof HostReportedActivitySchema>

export const IDLE_WORKSPACE_ACTIVITY: WorkspaceActivityFacts = {
  terminal: null,
  browser: false,
  structuredChat: false,
  agent: null
}

/** Map host-local activity to every listed row key; unlisted IDs have no row. */
export function keyWorkspaceActivityByRow(
  facts: Readonly<Record<string, WorkspaceActivityFacts>>,
  rows: Readonly<Record<string, { id: string }>>
): Record<HostScopedWorktreeKey, WorkspaceActivityFacts> {
  const keyed: Record<HostScopedWorktreeKey, WorkspaceActivityFacts> = {}
  for (const [identity, row] of Object.entries(rows)) {
    const key = parseWorktreeHostIdentity(identity)
    const fact = facts[row.id]
    if (key && fact) {
      keyed[key] = fact
    }
  }
  return keyed
}

export function isIdleWorkspaceActivity(facts: WorkspaceActivityFacts): boolean {
  return facts.terminal === null && !facts.browser && !facts.structuredChat && facts.agent === null
}

export function workspaceActivityFactsEqual(
  a: WorkspaceActivityFacts,
  b: WorkspaceActivityFacts
): boolean {
  return (
    a.terminal === b.terminal &&
    a.browser === b.browser &&
    a.structuredChat === b.structuredChat &&
    a.agent === b.agent
  )
}

/** Caller has already checked the row is fresh and not done. */
export function liveAgentStatusOf(
  entry: Pick<AgentStatusEntry, 'state' | 'workingMode'>
): LiveAgentWorktreeStatus {
  if (entry.state !== 'working') {
    return 'permission'
  }
  return entry.workingMode === 'monitoring' ? 'monitoring' : 'working'
}

export function strongerLiveAgentStatus(
  current: LiveAgentWorktreeStatus | null | undefined,
  next: LiveAgentWorktreeStatus
): LiveAgentWorktreeStatus {
  if (current === 'permission' || next === 'permission') {
    return 'permission'
  }
  return current === 'working' || next === 'working' ? 'working' : (current ?? next)
}
