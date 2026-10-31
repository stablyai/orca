import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { callStructuredAgentSession } from './structured-agent-session-client'
import { structuredAgentSessionHostKey } from './structured-agent-session-host-capability'

/** Host/agent saved model lists seed new-chat pickers without a first-frame guess. Only host answers populate entries; newer answers replace them, absence/account-setting changes drop them. */

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

/** Undefined until host answers for this frame. Workspace config can replace defaults, so another workspace’s answer is valid only for named models, no-default lists or host-proven workspace-independent defaults. */
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
  if (!listed || listed.modelsDifferByWorkspace) {
    return undefined
  }
  if (
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
    if (worktree === null) {
      snapshots.delete(key)
    } else {
      const entry = snapshots.get(key)
      const retired = entry?.byWorktree.get(worktree)
      if (entry && retired && entry.account === retired) {
        entry.account = null
      }
      entry?.byWorktree.delete(worktree)
    }
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
  recordHostModelCatalogSnapshot(target, agent, null, catalog)
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
}
