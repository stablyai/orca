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
const forgottenListeners = new Set<() => void>()
// Bumped per host and agent by each chat's answer, so an older preload never replaces it.
const chatAnswers = new Map<string, number>()

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
  const next = withHostModelCatalogAnswer(snapshots.get(key), worktree, catalog)
  if (worktree !== null && next !== snapshots.get(key) && next?.byWorktree.has(worktree)) {
    chatAnswers.set(key, (chatAnswers.get(key) ?? 0) + 1)
  }
  if (next) {
    snapshots.set(key, next)
  } else {
    snapshots.delete(key)
  }
}

/** Drop all or selected agents’ host answers when the account a new chat pins may change. */
export function forgetHostModelCatalogSnapshots(
  target: RuntimeClientTarget,
  agents?: readonly string[]
): void {
  const hostKey = structuredAgentSessionHostKey(target)
  generations.set(hostKey, (generations.get(hostKey) ?? 0) + 1)
  for (const key of snapshots.keys()) {
    const [keyHost, keyAgent] = key.split('\u0000')
    if (keyHost === hostKey && (!agents || agents.includes(keyAgent ?? ''))) {
      snapshots.delete(key)
    }
  }
  forgottenListeners.forEach((listener) => listener())
}

/** Changes whenever this host's answers are dropped, so a held answer can tell it is out of date. */
export function hostModelCatalogGeneration(target: RuntimeClientTarget): number {
  return generations.get(structuredAgentSessionHostKey(target)) ?? 0
}

export function subscribeHostModelCatalogForgotten(listener: () => void): () => void {
  forgottenListeners.add(listener)
  return () => forgottenListeners.delete(listener)
}

/** The agents a host has answered for, so a reconnect can read them again. */
export function hostModelCatalogSnapshotAgents(target: RuntimeClientTarget): string[] {
  const prefix = `${structuredAgentSessionHostKey(target)}\u0000`
  return [...snapshots.keys()]
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
}

/** Return the requested account reply; cross-workspace snapshot eligibility is a separate decision. */
export async function loadHostModelCatalogSnapshot(
  target: RuntimeClientTarget,
  agent: string,
  options: { savedOnly?: true; awaitListing?: true } = {}
): Promise<AgentSessionModelCatalogResult | undefined> {
  const hostKey = structuredAgentSessionHostKey(target)
  const generation = generations.get(hostKey) ?? 0
  const key = snapshotKey(hostKey, agent)
  const answersAtSend = chatAnswers.get(key) ?? 0
  let catalog = await callStructuredAgentSession<AgentSessionModelCatalogResult>(
    target,
    'agentSession.modelCatalog',
    { agent, ...(options.savedOnly ? { savedOnly: true } : {}) }
  )
  if (
    options.awaitListing &&
    !options.savedOnly &&
    catalog.listingInProgress &&
    (generations.get(hostKey) ?? 0) === generation
  ) {
    catalog = await callStructuredAgentSession<AgentSessionModelCatalogResult>(
      target,
      'agentSession.modelCatalog',
      { agent, waitForListing: true }
    )
  }
  if ((generations.get(hostKey) ?? 0) !== generation) {
    return undefined
  }
  if ((chatAnswers.get(key) ?? 0) === answersAtSend) {
    recordHostModelCatalogSnapshot(target, agent, null, catalog)
  }
  return catalog
}

/** Preload saved lists only on capable hosts; failed reads prove no absence. */
export async function preloadHostModelCatalogSnapshots(
  target: RuntimeClientTarget,
  agents: readonly string[],
  options: { savedOnly?: true; awaitListing?: true } = {}
): Promise<void> {
  await Promise.all(
    agents.map((agent) =>
      loadHostModelCatalogSnapshot(target, agent, options).catch(() => undefined)
    )
  )
}

export function resetHostModelCatalogSnapshotsForTests(): void {
  snapshots.clear()
  generations.clear()
  chatAnswers.clear()
}
