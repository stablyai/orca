import {
  getResolvedFolderExecutionOwner,
  getResolvedWorktreeExecutionOwner
} from '@/lib/resolved-worktree-execution-host'
import { isWindowsHostWslWorkspace } from '@/lib/execution-host-facts'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getLocalProjectRuntimeWorkspace } from '@/lib/local-project-runtime-workspace'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../../shared/runtime-host-status'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import type { AppState } from '@/store/types'
import { sshConnectFailureText } from '@/ssh/ssh-host-server-status-copy'
import { getConnectionIdFromState } from '@/lib/connection-context'
import {
  resolveWorktreeHostConnection,
  type WorktreeHostConnection
} from '@/lib/worktree-host-connection-phase'
import { isNativeChatTranscriptLocalReadable } from '../../../../shared/native-chat/transcript/native-chat-transcript-readability'
import {
  selectRuntimeAwareSshError,
  selectRuntimeAwareSshTargetLabel,
  selectRuntimeAwareSshTargetRemoved
} from '@/store/slices/runtime-environment-ssh'

export type TerminalPaneHostState = {
  /** Null preserves saved views until the owning host and project runtime are known. */
  nativeChatIsWslProject: boolean | null
  nativeChatTranscriptIsLocalReadable: boolean
  sshReconnectEnvironmentId: string | null
  /** The failure detail behind the status; the overlay shows only a canned sentence without it. */
  sshReconnectError: string | null
  sshReconnectStatus: WorktreeHostConnection['publishedStatus']
  sshReconnectTargetId: string | null
  sshReconnectTargetLabel: string
  sshReconnectTargetRemoved: boolean
}

/** An unserved local host's translated reason; main's error stays the English twin. */
function reconnectErrorText(
  state: AppState,
  environmentId: string | null,
  targetId: string,
  error: string | null
): string | null {
  if (error === null || environmentId !== null) {
    return error
  }
  return sshConnectFailureText(state.sshConnectionStates.get(targetId), error)
}

type LocalRuntimeWorkspace = NonNullable<
  Parameters<typeof getLocalProjectExecutionRuntimeContext>[4]
>['worktree']
const localReposByCatalog = new WeakMap<AppState['repos'], AppState['repos']>()
const localGroupsByCatalog = new WeakMap<AppState['projectGroups'], AppState['projectGroups']>()

function localCatalogRows<
  T extends { executionHostId?: string | null; connectionId?: string | null }
>(rows: readonly T[], cache: WeakMap<readonly T[], readonly T[]>): readonly T[] {
  let local = cache.get(rows)
  if (!local) {
    local = rows.filter((row) => getRepoExecutionHostId(row) === 'local')
    cache.set(rows, local)
  }
  return local
}

const folderRuntimeWorkspaceCache = new WeakMap<
  AppState['folderWorkspaces'][number],
  {
    repos: AppState['repos']
    groups: AppState['projectGroups']
    workspace: LocalRuntimeWorkspace
  }
>()
const localRuntimeCache = new WeakMap<
  LocalRuntimeWorkspace,
  {
    projects: AppState['projects']
    repos: AppState['repos']
    settings: AppState['settings']
    value: boolean | null
  }
>()

function selectLocalWslRuntime(state: AppState, workspace: LocalRuntimeWorkspace): boolean | null {
  if (!workspace.path) {
    return null
  }
  const previous = localRuntimeCache.get(workspace)
  if (
    previous &&
    previous.projects === state.projects &&
    previous.repos === state.repos &&
    (
      [
        'localWindowsRuntimeDefault',
        'localAgentRuntime',
        'localAgentWslDistro',
        'terminalWindowsShell',
        'terminalWindowsWslDistro'
      ] as const
    ).every((field) => previous.settings?.[field] === state.settings?.[field])
  ) {
    return previous.value
  }
  const runtime = getLocalProjectExecutionRuntimeContext(
    state,
    workspace.id,
    'win32',
    {},
    { worktree: workspace }
  )
  const value = runtime?.status === 'resolved' ? runtime.runtime.kind === 'wsl' : null
  localRuntimeCache.set(workspace, {
    projects: state.projects,
    repos: state.repos,
    settings: state.settings,
    value
  })
  return value
}

export function selectNativeChatWslProject(state: AppState, worktreeId: string): boolean | null {
  const scope = parseWorkspaceKey(worktreeId)
  const folderOwner =
    scope?.type === 'folder'
      ? getResolvedFolderExecutionOwner(state, scope.folderWorkspaceId)
      : null
  const worktreeOwner =
    scope?.type !== 'folder' ? getResolvedWorktreeExecutionOwner(state, worktreeId) : null
  const hostId = folderOwner?.hostId ?? worktreeOwner?.hostId
  const owner = hostId ? parseExecutionHostId(hostId) : null
  if (!owner) {
    return null
  }
  if (owner.kind === 'local') {
    if (getRendererAppPlatform() !== 'win32') {
      return false
    }
    if (worktreeOwner) {
      return selectLocalWslRuntime(state, worktreeOwner.workspace)
    }
    if (!folderOwner) {
      return null
    }
    const folder = folderOwner.workspace
    let cached = folderRuntimeWorkspaceCache.get(folder)
    if (!cached || cached.repos !== state.repos || cached.groups !== state.projectGroups) {
      // A unique applicable repo supplies its override; the folder itself needs no repo.
      const workspace = getLocalProjectRuntimeWorkspace(
        {
          ...state,
          folderWorkspaces: [folder],
          repos: localCatalogRows(state.repos, localReposByCatalog),
          projectGroups: localCatalogRows(state.projectGroups, localGroupsByCatalog)
        },
        worktreeId,
        { ...folder, executionHostId: owner.id }
      ) ?? {
        id: worktreeId,
        repoId: '',
        path: folder.folderPath,
        hostId: owner.id
      }
      cached = { repos: state.repos, groups: state.projectGroups, workspace }
      folderRuntimeWorkspaceCache.set(folder, cached)
    }
    return selectLocalWslRuntime(state, cached.workspace)
  }
  if (owner.kind === 'ssh') {
    return false
  }
  const hostPlatform = lastVerifiedRuntimeStatus(
    state.runtimeStatusByEnvironmentId.get(owner.environmentId)
  )?.hostPlatform
  const workspacePath = folderOwner?.workspace.folderPath ?? worktreeOwner?.workspace.path
  if (!hostPlatform || (hostPlatform === 'win32' && !workspacePath)) {
    return null
  }
  // Paired Windows non-UNC runtime remains unknown until host runtime facts are available (#28977).
  return hostPlatform === 'win32'
    ? isWindowsHostWslWorkspace(hostPlatform, workspacePath) || null
    : false
}

function computeTerminalPaneHostState(state: AppState, worktreeId: string): TerminalPaneHostState {
  const nativeChatIsWslProject = selectNativeChatWslProject(state, worktreeId)
  const connectionId = getConnectionIdFromState(state, worktreeId)
  const nativeChatTranscriptIsLocalReadableResult =
    isNativeChatTranscriptLocalReadable(connectionId)
  const host = resolveWorktreeHostConnection(state, worktreeId, connectionId)
  if (!host.targetId) {
    return {
      nativeChatIsWslProject,
      nativeChatTranscriptIsLocalReadable: nativeChatTranscriptIsLocalReadableResult,
      sshReconnectEnvironmentId: null,
      sshReconnectError: null,
      sshReconnectStatus: null,
      sshReconnectTargetId: null,
      sshReconnectTargetLabel: '',
      sshReconnectTargetRemoved: false
    }
  }
  const { targetId: sshReconnectTargetId, environmentId: sshReconnectEnvironmentId } = host
  return {
    nativeChatIsWslProject,
    nativeChatTranscriptIsLocalReadable: nativeChatTranscriptIsLocalReadableResult,
    sshReconnectEnvironmentId,
    sshReconnectError: reconnectErrorText(
      state,
      sshReconnectEnvironmentId,
      sshReconnectTargetId,
      selectRuntimeAwareSshError(state, sshReconnectEnvironmentId, sshReconnectTargetId)
    ),
    sshReconnectStatus: host.publishedStatus,
    sshReconnectTargetId,
    sshReconnectTargetLabel: selectRuntimeAwareSshTargetLabel(
      state,
      sshReconnectEnvironmentId,
      sshReconnectTargetId
    ),
    sshReconnectTargetRemoved: selectRuntimeAwareSshTargetRemoved(
      state,
      sshReconnectEnvironmentId,
      sshReconnectTargetId
    )
  }
}

function isSameHostState(a: TerminalPaneHostState, b: TerminalPaneHostState): boolean {
  return (
    a.nativeChatIsWslProject === b.nativeChatIsWslProject &&
    a.nativeChatTranscriptIsLocalReadable === b.nativeChatTranscriptIsLocalReadable &&
    a.sshReconnectEnvironmentId === b.sshReconnectEnvironmentId &&
    a.sshReconnectError === b.sshReconnectError &&
    a.sshReconnectStatus === b.sshReconnectStatus &&
    a.sshReconnectTargetId === b.sshReconnectTargetId &&
    a.sshReconnectTargetLabel === b.sshReconnectTargetLabel &&
    a.sshReconnectTargetRemoved === b.sshReconnectTargetRemoved
  )
}

// Identity checks must not keep a retired store alive after the last pane unmounts.
let cachedState: WeakRef<AppState> | null = null
let cachedByWorktreeId = new Map<string, TerminalPaneHostState>()
let previousByWorktreeId = new Map<string, TerminalPaneHostState>()

/** Memoize host resolution by whole store identity: ownership spans repo, folder, runtime and SSH state, so narrower keys can miss changes. Resolve once per worktree/publication and reuse unchanged results to avoid per-pane allocations. */
export function selectTerminalPaneHostState(
  state: AppState,
  worktreeId: string
): TerminalPaneHostState {
  if (state !== cachedState?.deref()) {
    previousByWorktreeId = cachedByWorktreeId
    cachedByWorktreeId = new Map()
    cachedState = new WeakRef(state)
  }
  const cached = cachedByWorktreeId.get(worktreeId)
  if (cached) {
    return cached
  }
  const next = computeTerminalPaneHostState(state, worktreeId)
  const previous = previousByWorktreeId.get(worktreeId)
  const result = previous && isSameHostState(previous, next) ? previous : next
  cachedByWorktreeId.set(worktreeId, result)
  return result
}

export function resetTerminalPaneHostStateMemoForTests(): void {
  cachedState = null
  cachedByWorktreeId = new Map()
  previousByWorktreeId = new Map()
}
