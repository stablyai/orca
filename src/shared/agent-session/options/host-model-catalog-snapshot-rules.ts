import type { GlobalSettings } from '../../global-settings-types'
import type { PersistedNativeChatSessionOptions } from '../../native-chat/input/native-chat-session-options'
import type { AgentSessionModelCatalogResult } from '../agent-session-wire'
import { AGENT_SESSION_MODEL_CATALOG_SAVED_ONLY_RUNTIME_CAPABILITY } from '../structured-agent-session-surface-capabilities'

// A host's model lists seed new-chat pickers without a first-frame guess; newer answers replace older ones.

type ListedHostModelCatalog = Exclude<AgentSessionModelCatalogResult, { origin: 'unknown' }>

/** One host's answers for one agent. */
export type HostModelCatalogSnapshot = {
  /** A session-less read's answer: the account a new chat would pin, with no workspace named. */
  readonly account: ListedHostModelCatalog | null
  /** A new chat's answer per worktree (`''` when it named none): only it says whether that
   *  workspace's own config replaces the listed default. */
  readonly byWorktree: ReadonlyMap<string, ListedHostModelCatalog>
}

export type HostModelCatalogLaunch = { newLaunch: boolean; worktree?: string; seedsModel: boolean }

function withoutNamedDefault(catalog: ListedHostModelCatalog): ListedHostModelCatalog {
  return {
    ...catalog,
    models: catalog.models.map((model) => ({ ...model, isDefault: false })),
    listingNamesConfiguredModel: false
  }
}

/** Undefined when no answer fits this launch. Workspace config can replace defaults, so another workspace’s answer is valid only for named models, no-default lists or host-proven workspace-independent defaults. */
export function selectHostModelCatalogSnapshot(
  snapshot: HostModelCatalogSnapshot | undefined,
  launch: HostModelCatalogLaunch
): AgentSessionModelCatalogResult | undefined {
  if (!snapshot) {
    return undefined
  }
  const exact = snapshot.byWorktree.get(launch.worktree ?? '')
  if (exact) {
    return exact
  }
  const listed = snapshot.account ?? snapshot.byWorktree.values().next().value
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

/** The snapshot after a host answer for `worktree` (null for a session-less read); undefined means keep none.
 *  An unknown or empty answer proves absence and retires what it answered for. */
export function withHostModelCatalogAnswer(
  snapshot: HostModelCatalogSnapshot | undefined,
  worktree: string | null,
  catalog: AgentSessionModelCatalogResult
): HostModelCatalogSnapshot | undefined {
  if (catalog.origin === 'unknown' || catalog.models.length === 0) {
    if (worktree === null || !snapshot) {
      return undefined
    }
    const retired = snapshot.byWorktree.get(worktree)
    const byWorktree = new Map(snapshot.byWorktree)
    byWorktree.delete(worktree)
    return {
      account: retired && snapshot.account === retired ? null : snapshot.account,
      byWorktree
    }
  }
  if (worktree === null) {
    // A newer account-level list supersedes per-workspace answers made from an older one.
    return { account: catalog, byWorktree: new Map() }
  }
  const byWorktree = new Map(snapshot?.byWorktree).set(worktree, catalog)
  // A default no workspace can replace is every new chat's, wherever it runs.
  return {
    account: catalog.defaultHoldsInEveryWorkspace === true ? catalog : (snapshot?.account ?? null),
    byWorktree
  }
}

/** Settings that change which account (or binary) a new chat lists under, as the host reads them;
 *  a change makes the held lists stale. */
export const HOST_MODEL_CATALOG_ACCOUNT_SETTINGS = [
  'activeCodexManagedAccountId',
  'activeCodexManagedAccountIdsByRuntime',
  'codexManagedAccounts',
  'activeClaudeManagedAccountId',
  'activeClaudeManagedAccountIdsByRuntime',
  'claudeManagedAccounts',
  'agentDefaultEnv',
  'agentCmdOverrides'
] as const satisfies readonly (keyof GlobalSettings)[]

/** A host that advertises saved-only reads answers every agent without starting its CLI. */
export function hostReadsSavedModelCatalogsOnly(
  capabilities: readonly string[] | null | undefined
): boolean {
  return capabilities?.includes(AGENT_SESSION_MODEL_CATALOG_SAVED_ONLY_RUNTIME_CAPABILITY) === true
}

/** Agents with a saved model pick: an older host lists when nothing is saved, so only these may be preloaded from it. */
export function agentsWithSavedModelPick(
  options: PersistedNativeChatSessionOptions | undefined
): string[] {
  return Object.entries(options ?? {})
    .filter(([, entry]) => typeof entry?.model === 'string' && entry.model.trim() !== '')
    .map(([agent]) => agent)
}
