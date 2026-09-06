import type { AppState } from '@/store/types'
import {
  createNormalizedPathInsideOrEqualMatcher,
  normalizeRuntimePathForComparison
} from '../../../shared/cross-platform-path'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import { getConnectionIdFromState } from './connection-owner-resolution'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import { runtimePathExists } from '@/runtime/runtime-file-metadata-client'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

export type AiVaultResumeCwdState = Pick<AppState, 'folderWorkspaces' | 'worktreesByRepo'>

export function getAiVaultResumeWorkspacePath(
  state: AiVaultResumeCwdState,
  worktreeId: string | null | undefined
): string | null {
  if (!worktreeId) {
    return null
  }
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return (
      state.folderWorkspaces.find((workspace) => workspace.id === workspaceScope.folderWorkspaceId)
        ?.folderPath ?? null
    )
  }
  const targetWorktreeId =
    workspaceScope?.type === 'worktree' ? workspaceScope.worktreeId : worktreeId
  return (
    Object.values(state.worktreesByRepo ?? {})
      .flat()
      .find((candidate) => candidate.id === targetWorktreeId)?.path ?? null
  )
}

export function resolveAiVaultResumeCwd(args: {
  state: AiVaultResumeCwdState
  worktreeId?: string | null
  sessionCwd: string | null
  platform: NodeJS.Platform
  sessionCwdExists?: boolean
}): string | null {
  const sessionCwd = args.sessionCwd
  if (!sessionCwd) {
    return null
  }
  const targetWorkspacePath = getAiVaultResumeWorkspacePath(args.state, args.worktreeId)
  if (!targetWorkspacePath) {
    return args.worktreeId ? null : sessionCwd
  }

  const targetCwd = normalizeAiVaultResumePathForPlatform(targetWorkspacePath, args.platform)
  if (args.platform === 'linux' && isWindowsDrivePath(targetWorkspacePath)) {
    // A Windows project path has no reliable Linux equivalent without the selected WSL distro.
    return sessionCwd
  }
  const sessionPath = normalizeAiVaultResumePathForPlatform(sessionCwd, args.platform)
  if (args.sessionCwdExists === false) {
    return targetCwd
  }
  if (
    createNormalizedPathInsideOrEqualMatcher(targetCwd)(
      normalizeRuntimePathForComparison(sessionPath)
    )
  ) {
    return sessionPath
  }

  // The recorded workspace no longer matches the selected target; start at the healthy target root.
  return targetCwd
}

export async function aiVaultResumeCwdExists(args: {
  state: AiVaultResumeCwdState & WorktreeRuntimeOwnerState
  worktreeId: string
  sessionCwd: string | null
  platform: NodeJS.Platform
}): Promise<boolean> {
  if (!args.sessionCwd) {
    return true
  }
  const workspacePath = getAiVaultResumeWorkspacePath(args.state, args.worktreeId)
  const connectionId =
    getConnectionIdFromState(
      args.state as Parameters<typeof getConnectionIdFromState>[0],
      args.worktreeId
    ) ?? undefined
  if (getRuntimeEnvironmentIdForWorktree(args.state, args.worktreeId)) {
    if (!workspacePath) {
      return false
    }
    const targetCwd = normalizeAiVaultResumePathForPlatform(workspacePath, args.platform)
    const sessionPath = normalizeAiVaultResumePathForPlatform(args.sessionCwd, args.platform)
    if (
      !createNormalizedPathInsideOrEqualMatcher(targetCwd)(
        normalizeRuntimePathForComparison(sessionPath)
      )
    ) {
      return false
    }
    return runtimePathExists(
      {
        settings: args.state.settings,
        worktreeId: args.worktreeId,
        worktreePath: workspacePath,
        connectionId
      },
      args.sessionCwd
    )
  }
  if (connectionId) {
    return window.api.fs.pathExists({ filePath: args.sessionCwd, connectionId })
  }
  return window.api.shell.pathExists(args.sessionCwd)
}

function normalizeAiVaultResumePathForPlatform(path: string, platform: NodeJS.Platform): string {
  if (platform === 'linux') {
    return parseWslUncPath(path)?.linuxPath ?? path
  }
  return path
}

function isWindowsDrivePath(path: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(path)
}
