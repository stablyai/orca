/** What a change in an SSH host's server means for the rest of the app. */
import { toast } from 'sonner'
import type {
  SshConnectionState,
  SshManagedServerLinkedProject
} from '../../../../shared/ssh-types'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { splitWorktreeId } from '../../../../shared/worktree/id'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { Repo } from '../../../../shared/repo-types'
import {
  type ExecutionHostId,
  getRepoExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { withoutConvertedSshHostRows } from '../../store/repos/converted-ssh-host-rows'
import { rekeyWorktreeVisitHost } from '@/lib/worktree-visit-recency'
import { preserveConvertedSshBrowserPages } from '../../store/repos/converted-ssh-browser-pages'

type ManagedServerStatus = SshConnectionState['managedServer']

export function applySshManagedServerTransition(
  targetId: string,
  previous: ManagedServerStatus,
  next: ManagedServerStatus
): void {
  if (next?.kind === 'managed') {
    // Starts and wakes keep the same owner; only a new server or a failed load needs a refresh.
    const current = catalogLoadByTarget.get(targetId)
    if (current?.environmentId !== next.environmentId) {
      startManagedServerCatalogLoad(targetId, next.environmentId, next.linked ?? [])
    } else if (current.pending && previous?.kind !== 'managed') {
      // Why: a reconnect during a doomed read must not be lost; replay it once if that read fails.
      current.reconnectedWhilePending = true
    }
    return
  }
  if (next?.kind === 'relay') {
    catalogLoadByTarget.delete(targetId)
  }
  remountBridgedTabsOnce(targetId, next)
  if (
    next?.kind === 'relay' &&
    next.reason === 'refused' &&
    !(
      previous?.kind === 'relay' &&
      previous.reason === 'refused' &&
      previous.detail === next.detail
    )
  ) {
    // `detail` is main's English refusal; the SSH Hosts status line shows it under "Details".
    toast.error(
      translate(
        'auto.hooks.ipcEvents.sshManagedServer.refusedBlocked',
        'This SSH host could not move to a managed Orca server. SSH Hosts in Settings shows why.'
      )
    )
  }
}

// Why not `previous`: a connect reply can write the bridged status into the store before its push.
const bridgedTargetsRemounted = new Set<string>()

/** COMPAT(legacy-relay-bridge): panes that mounted inert before the connect now reattach. */
function remountBridgedTabsOnce(targetId: string, next: ManagedServerStatus): void {
  if (!(next?.kind === 'relay' && next.bridged)) {
    bridgedTargetsRemounted.delete(targetId)
    return
  }
  if (bridgedTargetsRemounted.has(targetId)) {
    return
  }
  bridgedTargetsRemounted.add(targetId)
  // Why lazy: the panes module subscribes to the bridge when loaded; importing it here would do so
  // for every importer of this file.
  void import('../../components/terminal-pane/legacy-relay-bridge-panes').then(
    ({ legacyRelayBridgedTabIds }) => {
      const store = useAppStore.getState()
      for (const tabId of legacyRelayBridgedTabIds(targetId)) {
        store.remountTerminalTabForRecovery(tabId)
      }
    }
  )
}

type CatalogLoad = {
  environmentId: string
  linked: readonly SshManagedServerLinkedProject[]
  pending: boolean
  reconnectedWhilePending: boolean
}

const catalogLoadByTarget = new Map<string, CatalogLoad>()

function startManagedServerCatalogLoad(
  targetId: string,
  environmentId: string,
  linked: readonly SshManagedServerLinkedProject[]
): void {
  const load: CatalogLoad = { environmentId, linked, pending: true, reconnectedWhilePending: false }
  catalogLoadByTarget.set(targetId, load)
  void loadManagedServerCatalogs(targetId, load).then(
    () => {
      load.pending = false
    },
    (error: unknown) => {
      load.pending = false
      console.warn('[ssh] Could not load the managed server catalogs:', error)
      // Why: relay fallback and server replacement swap the record, which drops any replay.
      if (catalogLoadByTarget.get(targetId) !== load) {
        return
      }
      catalogLoadByTarget.delete(targetId)
      if (load.reconnectedWhilePending) {
        startManagedServerCatalogLoad(targetId, environmentId, load.linked)
      }
    }
  )
}

/** Loads a newly managed host's server and the local catalogs, then drops its relay-era rows. */
async function loadManagedServerCatalogs(targetId: string, load: CatalogLoad): Promise<void> {
  const { environmentId } = load
  const isCurrent = (): boolean => catalogLoadByTarget.get(targetId) === load
  // Pin existing desktop pages before the catalogs change their workspace owner.
  useAppStore.setState((state) => {
    const browserPagesByWorkspace = preserveConvertedSshBrowserPages(state, targetId)
    return browserPagesByWorkspace === state.browserPagesByWorkspace
      ? state
      : { browserPagesByWorkspace }
  })
  const store = useAppStore.getState()
  // Why: host badges read server names from this catalog, which a conversion does not refresh.
  const environments = await window.api.runtimeEnvironments.list()
  if (!isCurrent()) {
    return
  }
  store.setRuntimeEnvironments(environments)
  void store.refreshRuntimeEnvironmentStatus(environmentId)
  // Why local too: the host's relay-era rows come from the local catalog, which main now hides.
  for (const runtimeEnvironmentId of [null, environmentId]) {
    const options = { runtimeEnvironmentId, throwOnError: true }
    await store.fetchRepos(options)
    if (!isCurrent()) {
      return
    }
    // Why groups before folders: folder workspaces are owned through their project groups.
    await store.fetchProjectGroups(options)
    if (!isCurrent()) {
      return
    }
    await store.fetchFolderWorkspaces(options)
    if (!isCurrent()) {
      return
    }
  }
  // Why gated: startup runs its own scan once every host's catalog is in.
  if (useAppStore.getState().startupWorktreeRefreshCompleted) {
    const executionHostId = toRuntimeExecutionHostId(environmentId)
    const repos = useAppStore
      .getState()
      .repos.filter((repo) => getRepoExecutionHostId(repo) === executionHostId)
    await Promise.all(repos.map((repo) => store.fetchWorktrees(repo.id, { executionHostId })))
  }
  if (!isCurrent()) {
    return
  }
  // Read before the source rows go: a linked project keeps the server's id, not this desktop's.
  const linkedRepoIds = linkedServerRepoIds(
    useAppStore.getState().repos,
    targetId,
    environmentId,
    load.linked
  )
  useAppStore.setState((state) => {
    // Why: the host's workspaces are the server's now; unmoved, the next prune drops their recency.
    const lastVisitedAtByWorktreeId = rekeyWorktreeVisitHost(
      state.lastVisitedAtByWorktreeId,
      toSshExecutionHostId(targetId),
      toRuntimeExecutionHostId(environmentId)
    )
    return {
      ...withoutConvertedSshHostRows(state, targetId),
      ...(lastVisitedAtByWorktreeId === state.lastVisitedAtByWorktreeId
        ? {}
        : { lastVisitedAtByWorktreeId })
    }
  })
  rehomeActiveWorkspaceWhenKnown(targetId, environmentId, linkedRepoIds, isCurrent)
}

/**
 * Why keep watching: the server's worktree rows arrive with startup's scan on cold start, and a
 * failed scan leaves them missing until a later one, so a missing row never reads as no copy.
 */
function rehomeActiveWorkspaceWhenKnown(
  targetId: string,
  environmentId: string,
  linkedRepoIds: ReadonlyMap<string, string>,
  isCurrent: () => boolean
): void {
  if (rehomeActiveWorkspace(targetId, environmentId, linkedRepoIds) !== 'pending') {
    return
  }
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (!isCurrent()) {
      unsubscribe()
      return
    }
    if (
      state.worktreesByRepo === previous.worktreesByRepo &&
      state.detectedWorktreesByRepo === previous.detectedWorktreesByRepo &&
      state.activeWorktreeId === previous.activeWorktreeId &&
      state.activeWorkspaceExecutionHostId === previous.activeWorkspaceExecutionHostId
    ) {
      return
    }
    if (rehomeActiveWorkspace(targetId, environmentId, linkedRepoIds) !== 'pending') {
      unsubscribe()
    }
  })
}

/** This desktop's project id → the server's, for each project the move linked at the same path. */
function linkedServerRepoIds(
  repos: readonly Repo[],
  targetId: string,
  environmentId: string,
  linked: readonly SshManagedServerLinkedProject[]
): Map<string, string> {
  const linkedPaths = new Set(linked.map((entry) => normalizeRuntimePathForComparison(entry.path)))
  const sshHostId = toSshExecutionHostId(targetId)
  const runtimeHostId = toRuntimeExecutionHostId(environmentId)
  const serverIdByPath = new Map(
    repos
      .filter((repo) => getRepoExecutionHostId(repo) === runtimeHostId)
      .map((repo) => [normalizeRuntimePathForComparison(repo.path), repo.id])
  )
  const mapping = new Map<string, string>()
  for (const repo of repos) {
    const path = normalizeRuntimePathForComparison(repo.path)
    const serverId = serverIdByPath.get(path)
    if (getRepoExecutionHostId(repo) === sshHostId && linkedPaths.has(path) && serverId) {
      mapping.set(repo.id, serverId)
    }
  }
  return mapping
}

type ServerCopy = { kind: 'found'; worktreeId: string } | { kind: 'absent' } | { kind: 'pending' }

/**
 * The server's copy of a workspace: the same id, or the same checkout in the project it linked to.
 * Only a project the server's catalog lacks is absent; that catalog loaded or this never runs.
 */
function serverCopyOfWorkspace(
  worktreeId: string,
  runtimeHostId: ExecutionHostId,
  linkedRepoIds: ReadonlyMap<string, string>
): ServerCopy {
  const state = useAppStore.getState()
  if (state.getKnownWorktreeById(worktreeId, runtimeHostId)) {
    return { kind: 'found', worktreeId }
  }
  const source =
    parseWorkspaceKey(worktreeId)?.type === 'folder' ? null : splitWorktreeId(worktreeId)
  if (!source) {
    return { kind: 'absent' }
  }
  const serverRepoId = state.repos.some(
    (repo) => repo.id === source.repoId && getRepoExecutionHostId(repo) === runtimeHostId
  )
    ? source.repoId
    : linkedRepoIds.get(source.repoId)
  if (!serverRepoId) {
    return { kind: 'absent' }
  }
  const path = normalizeRuntimePathForComparison(source.worktreePath)
  // Why detected too: a checkout the server's visibility settings hide still exists there.
  const row = [
    ...(state.worktreesByRepo[serverRepoId] ?? []),
    ...(state.detectedWorktreesByRepo[serverRepoId]?.worktrees ?? [])
  ].find(
    (worktree) =>
      worktree.hostId === runtimeHostId && normalizeRuntimePathForComparison(worktree.path) === path
  )
  return row ? { kind: 'found', worktreeId: row.id } : { kind: 'pending' }
}

/** Why: an active workspace left on the SSH host keeps showing panes that dial the stopped relay. */
function rehomeActiveWorkspace(
  targetId: string,
  environmentId: string,
  linkedRepoIds: ReadonlyMap<string, string>
): 'settled' | 'pending' {
  const state = useAppStore.getState()
  const runtimeHostId = toRuntimeExecutionHostId(environmentId)
  if (
    !state.activeWorktreeId ||
    state.activeWorkspaceExecutionHostId !== toSshExecutionHostId(targetId)
  ) {
    return 'settled'
  }
  const copy = serverCopyOfWorkspace(state.activeWorktreeId, runtimeHostId, linkedRepoIds)
  if (copy.kind === 'pending') {
    return 'pending'
  }
  if (copy.kind === 'found') {
    // Why a transition: it makes the active repo follow the row, which a linked project renames.
    state.setActiveWorktree(copy.worktreeId, runtimeHostId, {
      stateTransition: () => ({ patch: {}, activate: true })
    })
    return 'settled'
  }
  // The server holds no project for it, so the SSH owner it names is retired.
  state.setActiveWorktree(null, undefined, {
    stateTransition: (current) => ({
      patch: current.repos.some((repo) => repo.id === current.activeRepoId)
        ? {}
        : { activeRepoId: null },
      activate: true
    })
  })
  return 'settled'
}
