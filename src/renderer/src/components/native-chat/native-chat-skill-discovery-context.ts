import {
  getProjectHostSetupProjectionFromState,
  type ProjectCatalogReadState
} from '@/store/project-host-setup-selector'
import type { AppState } from '../../store/types'
import type { SkillDiscoveryTarget } from '../../../../shared/skills'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/resolve-owner'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  resolveNativeChatTabDirectory,
  resolveNativeChatTabDirectoryResolution,
  type NativeChatTabDirectoryState
} from './native-chat-tab-directory'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

export type NativeChatSkillStateInputs = Pick<
  AppState,
  | 'activeRepoId'
  | 'activeWorkspaceExecutionHostId'
  | 'activeWorktreeId'
  | 'detectedWorktreesByRepo'
  | 'floatingWorkspacePath'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'repos'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  | 'settings'
  | 'structuredSessionLaunchDirectoryByTabId'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
  | 'worktreesByRepo'
> &
  ProjectCatalogReadState

type NativeChatSkillTab = { id: string; startupCwd?: string }

type NativeChatSkillWorktreeState = NativeChatTabDirectoryState & {
  tabsByWorktree: Record<string, readonly NativeChatSkillTab[]>
}

export type NativeChatSkillDiscoveryContext = {
  key: string
  cwd: string
  executionHostKind: 'local' | 'runtime' | 'ssh'
  runtimeTarget: RuntimeClientTarget
  discoveryTarget: SkillDiscoveryTarget
}

export function selectNativeChatSkillStateInputs(state: AppState): NativeChatSkillStateInputs {
  return {
    activeRepoId: state.activeRepoId,
    // Why: the owner resolver needs the picked host and detected rows to tell twins apart.
    activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId,
    activeWorktreeId: state.activeWorktreeId,
    detectedWorktreesByRepo: selectDetectedWorktreesByRepo(state),
    floatingWorkspacePath: state.floatingWorkspacePath,
    folderWorkspaces: selectFolderWorkspaces(state),
    projectGroups: state.projectGroups,
    projectHostSetupProjection: getProjectHostSetupProjectionFromState(state),
    repos: state.repos,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
    settings: state.settings,
    structuredSessionLaunchDirectoryByTabId: state.structuredSessionLaunchDirectoryByTabId,
    tabsByWorktree: state.tabsByWorktree,
    unifiedTabsByWorktree: state.unifiedTabsByWorktree,
    worktreesByRepo: selectWorktreesByRepo(state)
  }
}

export function resolveNativeChatSkillDiscoveryCwd(
  state: NativeChatSkillWorktreeState,
  terminalTabId: string
): string | null {
  const found = findNativeChatTab(state, terminalTabId)
  if (!found) {
    return null
  }
  // Scan and cache by pane startup directory, which may differ from the workspace root.
  const startupCwd = found.tab.startupCwd?.trim()
  if (startupCwd) {
    return startupCwd
  }
  return resolveNativeChatTabDirectory(state, terminalTabId, found.worktreeId)
}

/** A missing context that is not a failure: the chat's folder is known soon, when its pin arrives. */
export function isNativeChatSkillDiscoveryAwaitingDirectory(
  state: NativeChatSkillWorktreeState,
  terminalTabId: string
): boolean {
  const found = findNativeChatTab(state, terminalTabId)
  if (!found || found.tab.startupCwd?.trim()) {
    return false
  }
  return (
    resolveNativeChatTabDirectoryResolution(state, terminalTabId, found.worktreeId).status ===
    'awaiting-pin'
  )
}

export function resolveNativeChatSkillDiscoveryContext(
  state: NativeChatSkillStateInputs,
  terminalTabId: string
): NativeChatSkillDiscoveryContext | null {
  const worktreeId = findNativeChatTab(state, terminalTabId)?.worktreeId ?? null
  if (!worktreeId) {
    return null
  }
  const cwd = resolveNativeChatSkillDiscoveryCwd(state, terminalTabId)
  if (!cwd) {
    return null
  }

  const hostId = getExecutionHostIdForWorktree(state, worktreeId)
  const parsedHost = parseExecutionHostId(hostId)
  if (parsedHost?.kind === 'ssh') {
    return {
      key: JSON.stringify(['ssh', hostId, cwd]),
      cwd,
      executionHostKind: 'ssh',
      runtimeTarget: { kind: 'local' },
      discoveryTarget: { cwd, worktreeId }
    }
  }

  const owner = runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId: worktreeId })
  // Why: listing one twin's skills under the other's chat would offer skills that host lacks.
  if (owner.kind === 'ambiguous') {
    return null
  }
  const runtimeEnvironmentId = owner.environmentId
  // Global runtime selection cannot prove pane ownership; ambiguous legacy panes remain not-ready.
  if (parsedHost?.kind === 'runtime' && !runtimeEnvironmentId) {
    return null
  }
  const runtimeTarget: RuntimeClientTarget = runtimeEnvironmentId
    ? { kind: 'environment', environmentId: runtimeEnvironmentId }
    : { kind: 'local' }
  const projectRuntime = runtimeEnvironmentId
    ? undefined
    : getLocalProjectExecutionRuntimeContext(state, worktreeId)
  const projectRuntimeKey =
    projectRuntime?.status === 'resolved'
      ? projectRuntime.runtime.cacheKey
      : projectRuntime?.repair.cacheKey
  return {
    key: JSON.stringify([
      runtimeTarget.kind,
      runtimeTarget.kind === 'environment' ? runtimeTarget.environmentId : null,
      hostId,
      projectRuntimeKey ?? null,
      cwd
    ]),
    cwd,
    executionHostKind: runtimeEnvironmentId ? 'runtime' : 'local',
    runtimeTarget,
    // Let the owning runtime resolve WSL project preferences when this client lacks them.
    discoveryTarget: { cwd, worktreeId, ...(projectRuntime ? { projectRuntime } : {}) }
  }
}

function findNativeChatTab(
  state: Pick<NativeChatSkillWorktreeState, 'tabsByWorktree' | 'unifiedTabsByWorktree'>,
  tabId: string
): { worktreeId: string; tab: NativeChatSkillTab } | null {
  return (
    findTerminalTab(state.tabsByWorktree, tabId) ??
    findTerminalTab(state.unifiedTabsByWorktree ?? {}, tabId)
  )
}

function findTerminalTab(
  tabsByWorktree: Record<string, readonly NativeChatSkillTab[]>,
  terminalTabId: string
): { worktreeId: string; tab: NativeChatSkillTab } | null {
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    const tab = tabs.find((entry) => entry.id === terminalTabId)
    if (tab) {
      return { worktreeId, tab }
    }
  }
  return null
}
