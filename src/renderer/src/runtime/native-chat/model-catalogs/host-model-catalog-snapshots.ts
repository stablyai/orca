import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'
import {
  selectHostModelCatalogSnapshot,
  withHostModelCatalogAnswer,
  type HostModelCatalogLaunch,
  type HostModelCatalogSnapshot
} from '../../../../../shared/agent-session/options/host-model-catalog-snapshot-rules'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { callStructuredAgentSession } from '../requests/structured-agent-session-call'
import { structuredAgentSessionHostKey } from '../host-capabilities/structured-agent-session-host-capability'

// Per host and agent; absence or an account-setting change drops them.
const snapshots = new Map<string, HostModelCatalogSnapshot>()
// Bumped when a host's answers are dropped, so a preload sent before then records nothing.
const generations = new Map<string, number>()
const catalogGenerations = new Map<string, number>()
// Bumped per host and agent by each chat's answer, so an older preload never replaces it.
const chatAnswers = new Map<string, number>()

type CatalogChange =
  | { forgotten: true }
  | { forgotten: false; worktree: string | null; catalog: AgentSessionModelCatalogResult }
type CatalogListener = (change: CatalogChange) => void
const listeners = new Map<string, Set<CatalogListener>>()

export function subscribeHostModelCatalogSnapshot(
  target: RuntimeClientTarget,
  agent: string,
  listener: CatalogListener
): () => void {
  const key = snapshotKey(structuredAgentSessionHostKey(target), agent)
  const scoped = listeners.get(key) ?? new Set<CatalogListener>()
  listeners.set(key, scoped)
  scoped.add(listener)
  return () => {
    scoped.delete(listener)
    if (!scoped.size) {
      listeners.delete(key)
    }
  }
}

export function hostModelCatalogGeneration(target: RuntimeClientTarget, agent: string): number {
  const key = snapshotKey(structuredAgentSessionHostKey(target), agent)
  if (!catalogGenerations.has(key)) {
    catalogGenerations.set(key, 0)
  }
  return catalogGenerations.get(key)!
}

function snapshotKey(hostKey: string, agent: string): string {
  return `${hostKey}\u0000${agent}`
}

/** Undefined until host answers for this frame. */
export function readHostModelCatalogSnapshot(
  target: RuntimeClientTarget,
  agent: string,
  launch: HostModelCatalogLaunch
): AgentSessionModelCatalogResult | undefined {
  return selectHostModelCatalogSnapshot(
    snapshots.get(snapshotKey(structuredAgentSessionHostKey(target), agent)),
    launch
  )
}

/** Keeps a host answer for the account a new chat pins; `worktree` null for a session-less read. */
export function recordHostModelCatalogSnapshot(
  target: RuntimeClientTarget,
  agent: string,
  worktree: string | null,
  catalog: AgentSessionModelCatalogResult
): void {
  const key = snapshotKey(structuredAgentSessionHostKey(target), agent)
  const previous = snapshots.get(key)
  const next = withHostModelCatalogAnswer(previous, worktree, catalog)
  if (worktree !== null && next !== snapshots.get(key) && next?.byWorktree.has(worktree)) {
    chatAnswers.set(key, (chatAnswers.get(key) ?? 0) + 1)
  }
  const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)
  const unchanged =
    previous === next ||
    (same(previous?.account, next?.account) &&
      previous?.byWorktree.size === next?.byWorktree.size &&
      (worktree === null ||
        same(previous?.byWorktree.get(worktree), next?.byWorktree.get(worktree))))
  if (unchanged && catalog.origin !== 'unknown' && catalog.models.length > 0) {
    return
  }
  if (next) {
    snapshots.set(key, next)
  } else {
    snapshots.delete(key)
  }
  listeners.get(key)?.forEach((listener) => listener({ forgotten: false, worktree, catalog }))
}

/** Drop all or selected agents’ host answers when the account a new chat pins may change. */
export function forgetHostModelCatalogSnapshots(
  target: RuntimeClientTarget,
  agents?: readonly string[]
): void {
  const hostKey = structuredAgentSessionHostKey(target)
  generations.set(hostKey, (generations.get(hostKey) ?? 0) + 1)
  for (const [key, generation] of catalogGenerations) {
    const [keyHost, keyAgent] = key.split('\u0000')
    if (keyHost === hostKey && (!agents || agents.includes(keyAgent ?? ''))) {
      catalogGenerations.set(key, generation + 1)
    }
  }
  for (const key of snapshots.keys()) {
    const [keyHost, keyAgent] = key.split('\u0000')
    if (keyHost === hostKey && (!agents || agents.includes(keyAgent ?? ''))) {
      snapshots.delete(key)
    }
  }
  for (const [key, scoped] of listeners) {
    const [keyHost, keyAgent] = key.split('\u0000')
    if (keyHost === hostKey && (!agents || agents.includes(keyAgent ?? ''))) {
      scoped.forEach((listener) => listener({ forgotten: true }))
    }
  }
}

/** The agents a host has answered for, so a reconnect can read them again. */
export function hostModelCatalogSnapshotAgents(target: RuntimeClientTarget): string[] {
  const prefix = `${structuredAgentSessionHostKey(target)}\u0000`
  return [...snapshots.keys()]
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
}

/** Preload account-level lists per agent; failed reads prove no absence. Send savedOnly only when host advertises it, avoiding unsaved CLI listing. */
export async function preloadHostModelCatalogSnapshots(
  target: RuntimeClientTarget,
  agents: readonly string[],
  options: { savedOnly?: true } = {}
): Promise<void> {
  const hostKey = structuredAgentSessionHostKey(target)
  const generation = generations.get(hostKey) ?? 0
  await Promise.all(
    agents.map((agent) => {
      const key = snapshotKey(hostKey, agent)
      const answersAtSend = chatAnswers.get(key) ?? 0
      return callStructuredAgentSession<AgentSessionModelCatalogResult>(
        target,
        'agentSession.modelCatalog',
        { agent, ...options }
      )
        .then((catalog) => {
          if (
            (generations.get(hostKey) ?? 0) === generation &&
            (chatAnswers.get(key) ?? 0) === answersAtSend
          ) {
            recordHostModelCatalogSnapshot(target, agent, null, catalog)
          }
        })
        .catch(() => undefined)
    })
  )
}

export function resetHostModelCatalogSnapshotsForTests(): void {
  snapshots.clear()
  generations.clear()
  catalogGenerations.clear()
  chatAnswers.clear()
}
