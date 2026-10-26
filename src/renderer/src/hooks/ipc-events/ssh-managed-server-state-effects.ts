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
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

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
    toast.error(
      translate(
        'auto.hooks.ipcEvents.sshManagedServer.refusedBlocked',
        'Orca couldn’t set itself up on this SSH host. SSH Hosts in Settings shows why.'
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
  // Load panes lazily because module import itself subscribes to the bridge.
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
  // Conversion must refresh the server catalog too because host badges read its names.
  const environments = await window.api.runtimeEnvironments.list()
  if (!isCurrent()) {
    return
  }
  store.setRuntimeEnvironments(environments)
  void store.refreshRuntimeEnvironmentStatus(environmentId)
  // Refresh local catalogs to remove relay-era rows main now hides.
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
    await fetchServerWorktrees(environmentId)
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
    // Move recency with server-owned workspaces or mount pruning drops it.
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

async function fetchServerWorktrees(environmentId: string): Promise<void> {
  const executionHostId = toRuntimeExecutionHostId(environmentId)
  const state = useAppStore.getState()
  const repos = state.repos.filter((repo) => getRepoExecutionHostId(repo) === executionHostId)
  await Promise.all(repos.map((repo) => state.fetchWorktrees(repo.id, { executionHostId })))
}

// Watch later scans: startup may precede server rows or fail, so missing rows cannot prove absence.
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
    const startupScanFinished =
      state.startupWorktreeRefreshCompleted && !previous.startupWorktreeRefreshCompleted
    if (
      !startupScanFinished &&
      selectWorktreesByRepo(state) === selectWorktreesByRepo(previous) &&
      selectDetectedWorktreesByRepo(state) === selectDetectedWorktreesByRepo(previous) &&
      state.activeWorktreeId === previous.activeWorktreeId &&
      state.activeWorkspaceExecutionHostId === previous.activeWorkspaceExecutionHostId
    ) {
      return
    }
    if (rehomeActiveWorkspace(targetId, environmentId, linkedRepoIds) !== 'pending') {
      unsubscribe()
    } else if (startupScanFinished) {
      // Why: that scan may have started before the server's projects loaded, or failed for them.
      fetchServerWorktrees(environmentId).catch((error: unknown) => {
        console.warn('[ssh] Could not list the managed server worktrees:', error)
      })
    }
  })
}

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

/** Match server workspace by ID or linked checkout path; only a project absent from the loaded server catalog proves absence. */
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
    ...(selectWorktreesByRepo(state)[serverRepoId] ?? []),
    ...(selectDetectedWorktreesByRepo(state)[serverRepoId]?.worktrees ?? [])
  ].find(
    (worktree) =>
      worktree.hostId === runtimeHostId && normalizeRuntimePathForComparison(worktree.path) === path
  )
  return row ? { kind: 'found', worktreeId: row.id } : { kind: 'pending' }
}

// Move active ownership off SSH or mounted panes keep dialing the stopped relay.
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
