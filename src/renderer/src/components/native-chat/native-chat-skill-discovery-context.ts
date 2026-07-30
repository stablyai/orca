import type { AppState } from '../../store/types'
import type { SkillDiscoveryTarget } from '../../../../shared/skills'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  getExplicitRuntimeEnvironmentIdForWorktree,
  getExecutionHostIdForWorktree
} from '@/lib/worktree-runtime-owner'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'

export type NativeChatSkillStateInputs = Pick<
  AppState,
  | 'activeRepoId'
  | 'activeWorktreeId'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'projects'
  | 'repos'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  | 'settings'
  | 'tabsByWorktree'
  | 'worktreesByRepo'
>

type NativeChatSkillTab = { id: string; startupCwd?: string }

type NativeChatSkillWorktreeState = {
  tabsByWorktree: Record<string, readonly NativeChatSkillTab[]>
  worktreesByRepo: Record<string, readonly { id: string; path: string }[]>
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
    folderWorkspaces: state.folderWorkspaces,
    projectGroups: state.projectGroups,
    projects: state.projects,
    repos: state.repos,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
    settings: state.settings,
    tabsByWorktree: state.tabsByWorktree,
    worktreesByRepo: state.worktreesByRepo
  }
}

export function resolveNativeChatSkillDiscoveryCwd(
  state: NativeChatSkillWorktreeState,
  terminalTabId: string
): string | null {
  const found = findTerminalTab(state.tabsByWorktree, terminalTabId)
  if (!found) {
    return null
  }
  // Why: the agent runs where its pane started. A pane launched in a
  // subdirectory must not scan (or share a cache key with) the worktree root.
  const startupCwd = found.tab.startupCwd?.trim()
  if (startupCwd) {
    return startupCwd
  }
  for (const worktrees of Object.values(state.worktreesByRepo)) {
    const worktree = worktrees.find((entry) => entry.id === found.worktreeId)
    if (worktree) {
      return worktree.path
    }
  }
  return null
}

export function resolveNativeChatSkillDiscoveryContext(
  state: NativeChatSkillStateInputs,
  terminalTabId: string
): NativeChatSkillDiscoveryContext | null {
  const worktreeId = findTerminalTab(state.tabsByWorktree, terminalTabId)?.worktreeId ?? null
  if (!worktreeId) {
    return null
  }
  const workspaceScope = parseWorkspaceKey(worktreeId)
  const cwd =
    resolveNativeChatSkillDiscoveryCwd(state, terminalTabId) ??
    (workspaceScope?.type === 'folder'
      ? state.folderWorkspaces.find(
          (workspace) => workspace.id === workspaceScope.folderWorkspaceId
        )?.folderPath
      : null)
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
