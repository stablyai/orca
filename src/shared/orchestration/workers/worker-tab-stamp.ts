import { workerTabHasNewAgent } from './worker-tab-agent-identity'
import { z } from 'zod'

/** Durable, public agent identity: terminal agents by pane, native chats by session lineage root (survives /clear). */
export type AgentPublicIdentity =
  | { kind: 'pane'; paneKey: string }
  | { kind: 'session'; lineageRootSessionId: string }

/** One Dispatch's lineage as stamped on the surface Orca created for it. */
export type WorkerTabLineage = {
  runId: string
  dispatchId: string
  taskId: string
  taskTitle?: string
  parent: AgentPublicIdentity
  coordinator: AgentPublicIdentity
  /** Terminal workers only: the leaf Orca created or bound. */
  workerLeafId?: string
  /** The receiving host has an attachment; only the Run home can fence a stop. */
  stopRequiresHome?: true
}

/** Host-owned stamp on a tab Orca created for a worker; clients never write it. */
export type WorkerTabStamp = {
  /** Immutable provenance from creation. */
  origin: WorkerTabLineage
  /** The latest Dispatch bound to the worker leaf; absent until a re-bind. */
  current?: WorkerTabLineage
  /** Agent identity at the latest bind, so a different session in the leaf can reclaim the live title. */
  agentIdentity?: { agentType: string; providerSessionId?: string }
}

const agentPublicIdentitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pane'), paneKey: z.string().min(1) }),
  z.object({ kind: z.literal('session'), lineageRootSessionId: z.string().min(1) })
])

const workerTabLineageSchema = z.object({
  runId: z.string().min(1),
  dispatchId: z.string().min(1),
  taskId: z.string().min(1),
  taskTitle: z.string().optional(),
  parent: agentPublicIdentitySchema,
  coordinator: agentPublicIdentitySchema,
  workerLeafId: z.string().min(1).optional(),
  stopRequiresHome: z.literal(true).optional()
})

// Why .catch: a corrupt stamp degrades to an ordinary visible tab instead of rejecting the saved session.
export const workerTabStampSchema = z
  .object({
    origin: workerTabLineageSchema,
    current: workerTabLineageSchema.optional(),
    agentIdentity: z
      .object({ agentType: z.string(), providerSessionId: z.string().optional() })
      .optional()
  })
  .optional()
  .catch(undefined)

/** Fill the leaf Orca allocated; a stamp that already names its leaf is kept. */
export function withWorkerLeaf(stamp: WorkerTabStamp, leafId: string): WorkerTabStamp {
  if (stamp.origin.workerLeafId) {
    return stamp
  }
  return { ...stamp, origin: { ...stamp.origin, workerLeafId: leafId } }
}

/** The lineage that describes the tab now: the latest re-bind, else creation. */
export function currentWorkerLineage(stamp: WorkerTabStamp): WorkerTabLineage {
  return stamp.current ?? stamp.origin
}

/** Leaves Orca owns in a stamped terminal tab; every other leaf is the user's. */
export function workerLeafIds(stamp: WorkerTabStamp): ReadonlySet<string> {
  const ids = new Set<string>()
  if (stamp.origin.workerLeafId) {
    ids.add(stamp.origin.workerLeafId)
  }
  if (stamp.current?.workerLeafId) {
    ids.add(stamp.current.workerLeafId)
  }
  return ids
}

export function agentPublicIdentitiesEqual(
  a: AgentPublicIdentity | undefined,
  b: AgentPublicIdentity | undefined
): boolean {
  if (!a || !b) {
    return a === b
  }
  if (a.kind === 'pane') {
    return b.kind === 'pane' && a.paneKey === b.paneKey
  }
  return b.kind === 'session' && a.lineageRootSessionId === b.lineageRootSessionId
}

function lineagesEqual(a: WorkerTabLineage | undefined, b: WorkerTabLineage | undefined): boolean {
  if (!a || !b) {
    return a === b
  }
  return (
    a.runId === b.runId &&
    a.dispatchId === b.dispatchId &&
    a.taskId === b.taskId &&
    a.taskTitle === b.taskTitle &&
    a.workerLeafId === b.workerLeafId &&
    a.stopRequiresHome === b.stopRequiresHome &&
    agentPublicIdentitiesEqual(a.parent, b.parent) &&
    agentPublicIdentitiesEqual(a.coordinator, b.coordinator)
  )
}

/** Structural equality so host metadata-only changes apply and unchanged echoes keep identity. */
export function workerTabStampsEqual(
  a: WorkerTabStamp | undefined,
  b: WorkerTabStamp | undefined
): boolean {
  if (!a || !b) {
    return a === b
  }
  return (
    lineagesEqual(a.origin, b.origin) &&
    lineagesEqual(a.current, b.current) &&
    a.agentIdentity?.agentType === b.agentIdentity?.agentType &&
    a.agentIdentity?.providerSessionId === b.agentIdentity?.providerSessionId
  )
}

/** The Task title a worker tab was last bound to, for labels when live orchestration labels are gone. */
export function stampedTaskTitle(tab: { workerTab?: WorkerTabStamp }): string | undefined {
  return tab.workerTab && !workerTabHasNewAgent(tab.workerTab)
    ? currentWorkerLineage(tab.workerTab).taskTitle
    : undefined
}

export function isWorkerLeaf(stamp: WorkerTabStamp | undefined, leafId: string): boolean {
  return Boolean(
    stamp && (stamp.origin.workerLeafId === leafId || stamp.current?.workerLeafId === leafId)
  )
}

export function transferWorkerStamp<T extends { id: string; workerTab?: WorkerTabStamp }>(
  tabs: readonly T[],
  sourceId: string,
  targetId: string,
  leafId: string
): T[] | readonly T[] {
  const stamp = tabs.find((tab) => tab.id === sourceId)?.workerTab
  if (!isWorkerLeaf(stamp, leafId)) {
    return tabs
  }
  return tabs.map((tab) => {
    if (tab.id === targetId) {
      return { ...tab, workerTab: stamp }
    }
    if (tab.id !== sourceId) {
      return tab
    }
    return { ...tab, workerTab: undefined }
  })
}
