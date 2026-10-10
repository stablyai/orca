import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import type { RuntimeClientTarget } from './runtime-client-target'
import { callStructuredAgentSession } from './structured-agent-session-client'
import { structuredAgentSessionHostKey } from './structured-agent-session-host-capability'

/**
 * The host's saved model list per host and agent, as the host last answered it, so a new chat's
 * picker renders the host's list on its first frame instead of a guess it corrects. The host stays
 * the only source: every entry is a host answer, replaced by the next one, and dropped when the
 * host says it has none or a setting that picks the account changes.
 */

type ListedCatalog = Exclude<AgentSessionModelCatalogResult, { origin: 'unknown' }>

type AgentSnapshots = {
  /** A session-less read's answer: the account a new chat would pin, with no workspace named. */
  account: ListedCatalog | null
  /** A new chat's answer per worktree (`''` when it named none): only it says whether that
   *  workspace's own config replaces the listed default. */
  byWorktree: Map<string, ListedCatalog>
}

const snapshots = new Map<string, AgentSnapshots>()
// Bumped when a host's answers are dropped, so a preload sent before then records nothing.
const generations = new Map<string, number>()

function snapshotKey(hostKey: string, agent: string): string {
  return `${hostKey}\u0000${agent}`
}

function withoutNamedDefault(catalog: ListedCatalog): ListedCatalog {
  return {
    ...catalog,
    models: catalog.models.map((model) => ({ ...model, isDefault: false })),
    listingNamesConfiguredModel: false
  }
}

/**
 * What a chat's first frame may render from: undefined until the host has answered what that
 * frame would show. Whether a new chat runs the listed default depends on its workspace's own
 * config, so another workspace's answer serves only a chat that names its model, a list that
 * names no default, or a default the host says no workspace can replace.
 */
export function readHostModelCatalogSnapshot(
  target: RuntimeClientTarget,
  agent: string,
  launch: { newLaunch: boolean; worktree?: string; seedsModel: boolean }
): AgentSessionModelCatalogResult | undefined {
  const entry = snapshots.get(snapshotKey(structuredAgentSessionHostKey(target), agent))
  if (!entry) {
    return undefined
  }
  const exact = entry.byWorktree.get(launch.worktree ?? '')
  if (exact) {
    return exact
  }
  const listed = entry.account ?? entry.byWorktree.values().next().value
  if (
    !listed ||
    !launch.newLaunch ||
    listed.listingNamesConfiguredModel === false ||
    listed.defaultHoldsInEveryWorkspace === true
  ) {
    return listed
  }
  return launch.seedsModel ? withoutNamedDefault(listed) : undefined
}

/** Keeps a host answer for the account a new chat pins; `worktree` null for a session-less read. */
export function recordHostModelCatalogSnapshot(
  target: RuntimeClientTarget,
  agent: string,
  worktree: string | null,
  catalog: AgentSessionModelCatalogResult
): void {
  const key = snapshotKey(structuredAgentSessionHostKey(target), agent)
  if (catalog.origin === 'unknown' || catalog.models.length === 0) {
    // The account a new chat pins has no list: an older answer belongs to another account.
    snapshots.delete(key)
    return
  }
  const entry = snapshots.get(key) ?? { account: null, byWorktree: new Map() }
  if (worktree === null) {
    // A newer account-level list supersedes per-workspace answers made from an older one.
    snapshots.set(key, { account: catalog, byWorktree: new Map() })
    return
  }
  entry.byWorktree.set(worktree, catalog)
  // A default no workspace can replace is every new chat's, wherever it runs.
  snapshots.set(
    key,
    catalog.defaultHoldsInEveryWorkspace === true ? { ...entry, account: catalog } : entry
  )
}

/** Drops a host's answers, for every agent or only `agents`: the account they were for may not be
 *  the one a new chat pins now. */
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
}

/** The agents a host has answered for, so a reconnect can read them again. */
export function hostModelCatalogSnapshotAgents(target: RuntimeClientTarget): string[] {
  const prefix = `${structuredAgentSessionHostKey(target)}\u0000`
  return [...snapshots.keys()]
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
}

/** Reads the account-level list for each agent ahead of any chat. A failed read keeps nothing new:
 *  it is not evidence the host has no list. `savedOnly` asks the host to answer from what it saved
 *  and start no listing; send it only to a host advertising the saved-only capability. */
export async function preloadHostModelCatalogSnapshots(
  target: RuntimeClientTarget,
  agents: readonly string[],
  options: { savedOnly?: true } = {}
): Promise<void> {
  const hostKey = structuredAgentSessionHostKey(target)
  const generation = generations.get(hostKey) ?? 0
  await Promise.all(
    agents.map((agent) =>
      callStructuredAgentSession<AgentSessionModelCatalogResult>(
        target,
        'agentSession.modelCatalog',
        { agent, ...options }
      )
        .then((catalog) => {
          if ((generations.get(hostKey) ?? 0) === generation) {
            recordHostModelCatalogSnapshot(target, agent, null, catalog)
          }
        })
        .catch(() => undefined)
    )
  )
}

export function resetHostModelCatalogSnapshotsForTests(): void {
  snapshots.clear()
  generations.clear()
}
