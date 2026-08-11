import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'
import { isPathInsideOrEqual } from '../../../../shared/cross-platform-path'
import { getProjectGroupSubtreeIds } from '../../../../shared/project-groups'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { TerminalTab } from '../../../../shared/types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  resolveDirectSshTargetScope,
  type DirectSshTargetScopeInput
} from '../../lib/direct-ssh-target-scope'

function isExplicitContradictoryHost(
  rawHostId: string | null | undefined,
  expectedHostId: string
): boolean {
  if (!rawHostId?.trim()) {
    return false
  }
  const parsed = parseExecutionHostId(rawHostId)
  return parsed == null || parsed.id !== expectedHostId
}

function worktreeHasContradictoryOwner(
  input: DirectSshTargetScopeInput,
  worktreeId: string
): boolean {
  const rows = [
    ...Object.values(input.worktreesByRepo ?? {}).flat(),
    ...Object.values(input.detectedWorktreesByRepo ?? {}).flatMap((entry) => entry.worktrees)
  ].filter((worktree) => worktree.id === worktreeId)
  const expectedHostId = toSshExecutionHostId(input.targetId)
  for (const row of rows) {
    if (
      row.runtimeOwnerEnvironmentId?.trim() ||
      isExplicitContradictoryHost(row.hostId, expectedHostId)
    ) {
      return true
    }
    const repos = input.repos.filter((repo) => repo.id === row.repoId)
    if (repos.some((repo) => getRepoExecutionHostId(repo) !== expectedHostId)) {
      return true
    }
  }
  const restored = input.restoredRuntimeHostIdByWorkspaceSessionKey
  return (
    isExplicitContradictoryHost(restored?.[worktreeId], expectedHostId) ||
    isExplicitContradictoryHost(restored?.[worktreeWorkspaceKey(worktreeId)], expectedHostId)
  )
}

function folderHasContradictoryOwner(
  input: DirectSshTargetScopeInput,
  folderWorkspaceId: string
): boolean {
  const expectedHostId = toSshExecutionHostId(input.targetId)
  const folders = (input.folderWorkspaces ?? []).filter((folder) => folder.id === folderWorkspaceId)
  for (const folder of folders) {
    if (isExplicitContradictoryHost(folder.executionHostId, expectedHostId)) {
      return true
    }
    if (folder.connectionId?.trim() && folder.connectionId.trim() !== input.targetId) {
      return true
    }
    const groups = (input.projectGroups ?? []).filter((group) => group.id === folder.projectGroupId)
    if (
      groups.some(
        (group) =>
          (group.connectionId?.trim() && group.connectionId.trim() !== input.targetId) ||
          isExplicitContradictoryHost(group.executionHostId, expectedHostId)
      )
    ) {
      return true
    }
    const groupIds = getProjectGroupSubtreeIds(input.projectGroups ?? [], folder.projectGroupId)
    const candidateRepos = input.repos.filter(
      (repo) =>
        (repo.projectGroupId != null && groupIds.has(repo.projectGroupId)) ||
        isPathInsideOrEqual(folder.folderPath, repo.path)
    )
    if (candidateRepos.some((repo) => getRepoExecutionHostId(repo) !== expectedHostId)) {
      return true
    }
  }
  return isExplicitContradictoryHost(
    input.restoredRuntimeHostIdByWorkspaceSessionKey?.[folderWorkspaceKey(folderWorkspaceId)],
    expectedHostId
  )
}

function workspaceHasContradictoryOwner(
  input: DirectSshTargetScopeInput,
  workspaceKey: string
): boolean {
  if (workspaceKey.startsWith('folder:')) {
    return folderHasContradictoryOwner(input, workspaceKey.slice('folder:'.length))
  }
  return worktreeHasContradictoryOwner(input, workspaceKey)
}

export function resolveDirectSshTerminalWorkspaceKeys(
  input: DirectSshTargetScopeInput,
  tabsByWorktree: Readonly<Record<string, readonly TerminalTab[]>>,
  lastKnownRelayPtyIdByTabId: Readonly<Record<string, string>> = {}
): Set<string> {
  const keys = new Set(resolveDirectSshTargetScope(input).terminalWorkspaceKeys)
  for (const [workspaceKey, tabs] of Object.entries(tabsByWorktree)) {
    const liveSshTargets = new Set(
      tabs
        .map((tab) => parseAppSshPtyId(tab.ptyId ?? '')?.connectionId)
        .filter((targetId): targetId is string => Boolean(targetId))
    )
    const retainedSshTargets = new Set(
      tabs
        .map((tab) => parseAppSshPtyId(lastKnownRelayPtyIdByTabId[tab.id] ?? '')?.connectionId)
        .filter((targetId): targetId is string => Boolean(targetId))
    )
    const ptyTargets = liveSshTargets.size > 0 ? liveSshTargets : retainedSshTargets
    if (
      keys.has(workspaceKey) ||
      workspaceHasContradictoryOwner(input, workspaceKey) ||
      ptyTargets.size !== 1 ||
      !ptyTargets.has(input.targetId)
    ) {
      continue
    }
    keys.add(workspaceKey)
  }
  return keys
}
