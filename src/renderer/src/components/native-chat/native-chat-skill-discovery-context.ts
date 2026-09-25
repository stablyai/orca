import type { AppState } from '../../store/types'
import type { SkillDiscoveryTarget } from '../../../../shared/skills'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  getExplicitRuntimeEnvironmentIdForWorktree,
  getExecutionHostIdForWorktree
} from '@/lib/worktree-runtime-owner'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  resolveNativeChatTabDirectory,
  resolveNativeChatTabDirectoryResolution,
  type NativeChatTabDirectoryState
} from './native-chat-tab-directory'

export type NativeChatSkillStateInputs = Pick<
  AppState,
  | 'activeRepoId'
  | 'activeWorktreeId'
  | 'floatingWorkspacePath'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'projects'
  | 'repos'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  | 'settings'
  | 'structuredSessionWorkspacePathByTabId'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
  | 'worktreesByRepo'
>

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
    activeWorktreeId: state.activeWorktreeId,
    floatingWorkspacePath: state.floatingWorkspacePath,
    folderWorkspaces: state.folderWorkspaces,
    projectGroups: state.projectGroups,
    projects: state.projects,
    repos: state.repos,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
    settings: state.settings,
    structuredSessionWorkspacePathByTabId: state.structuredSessionWorkspacePathByTabId,
    tabsByWorktree: state.tabsByWorktree,
    unifiedTabsByWorktree: state.unifiedTabsByWorktree,
    worktreesByRepo: state.worktreesByRepo
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
  // Why: the agent runs where its pane started. A pane launched in a
  // subdirectory must not scan (or share a cache key with) the worktree root.
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

  const runtimeEnvironmentId = getExplicitRuntimeEnvironmentIdForWorktree(state, worktreeId)
  // Why: a selected global runtime is not proof that it owns this pane. Modern
  // panes carry an owner stamp; ambiguous legacy panes stay not-ready.
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
    // Why: worktreeId lets the owning runtime resolve its own WSL project
    // preference when this client cannot supply projectRuntime (environment-
    // owned panes resolve host semantics on the runtime, never here).
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
