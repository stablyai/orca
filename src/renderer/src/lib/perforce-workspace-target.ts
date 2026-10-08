import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { settingsForRepoOwner } from '@/store/slices/worktrees/listing/worktree-owner-settings'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { isFolderRepo, isPerforceRepo } from '../../../shared/repo-kind'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import type { RuntimeGitContext } from '../runtime/runtime-git-client-context'
import type { AppState } from '@/store'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { relativePathInsideRoot } from '../../../shared/cross-platform-path'
import { isPerforceWorkspaceForFiles } from './perforce-workspace-detection'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type {
  PerforceProjectTarget,
  PerforceWorkspaceTarget
} from '../runtime/runtime-perforce-client'

/** What a Perforce request carries from Settings: Perforce's own, and the agent choices descriptions use. */
type PerforceTargetSettings = Partial<
  Pick<GlobalSettings, 'perforce' | 'agentCmdOverrides' | 'defaultTuiAgent'>
>

function buildTarget(
  worktreeId: string,
  worktreePath: string,
  connectionId: string | null | undefined,
  environmentId: string | null,
  settings: PerforceTargetSettings
): PerforceWorkspaceTarget {
  return {
    settings: { ...settings, activeRuntimeEnvironmentId: environmentId },
    worktreeId,
    worktreePath,
    ...(connectionId ? { connectionId } : {})
  }
}

/** The Perforce target of workspace `worktreeId`, routed to the host that owns it (read now). */
export function perforceTargetForWorktree(
  worktreeId: string,
  worktreePath: string,
  connectionId: string | null | undefined
): PerforceWorkspaceTarget {
  const state = useAppStore.getState()
  return buildTarget(
    worktreeId,
    worktreePath,
    connectionId,
    getRuntimeEnvironmentIdForWorktree(state, worktreeId),
    {
      perforce: state.settings?.perforce,
      agentCmdOverrides: state.settings?.agentCmdOverrides,
      defaultTuiAgent: state.settings?.defaultTuiAgent
    }
  )
}

/** Same as `perforceTargetForWorktree`, kept stable across renders while its inputs are. */
export function usePerforceWorkspaceTarget(
  worktreeId: string | null | undefined,
  worktreePath: string | null | undefined,
  connectionId: string | null | undefined
): PerforceWorkspaceTarget | null {
  const environmentId = useAppStore((s) => getRuntimeEnvironmentIdForWorktree(s, worktreeId))
  const perforce = useAppStore((s) => s.settings?.perforce)
  const agentCmdOverrides = useAppStore((s) => s.settings?.agentCmdOverrides)
  const defaultTuiAgent = useAppStore((s) => s.settings?.defaultTuiAgent)
  return useMemo(
    () =>
      worktreeId && worktreePath
        ? buildTarget(worktreeId, worktreePath, connectionId, environmentId, {
            perforce,
            agentCmdOverrides,
            defaultTuiAgent
          })
        : null,
    [
      worktreeId,
      worktreePath,
      connectionId,
      environmentId,
      perforce,
      agentCmdOverrides,
      defaultTuiAgent
    ]
  )
}

/** The Perforce folder project `repoId` (on `hostId` when ids repeat across hosts), routed to its owner. */
export function perforceProjectTarget(
  repoId: string,
  hostId?: ExecutionHostId | null
): PerforceProjectTarget {
  return {
    settings: settingsForRepoOwner(useAppStore.getState(), repoId, hostId),
    repoId,
    ...(hostId ? { hostId } : {})
  }
}

type FileWorkspace = {
  worktreeId: string
  worktreePath: string
  connectionId: string | null | undefined
  environmentId: string | null
  repo: Repo | null
}

function folderRepoOf(state: AppState, worktree: Pick<Worktree, 'repoId' | 'hostId'>) {
  const repo = findRepoForHost(state.repos, worktree.repoId, {
    hostId: worktree.hostId,
    settings: state.settings
  })
  return repo && isFolderRepo(repo) ? repo : null
}

/**
 * The workspace a file operation runs in: `context`'s own when it holds the file, else a known
 * Perforce workspace that does (a file opened from another workspace's terminal, say).
 */
function workspaceOfFile(
  state: AppState,
  context: RuntimeGitContext,
  absolutePath: string | undefined
): FileWorkspace | null {
  const own = context.worktreeId ? state.getKnownWorktreeById(context.worktreeId) : undefined
  const ownPath = own?.path ?? context.worktreePath
  if (
    context.worktreeId &&
    ownPath &&
    (!absolutePath || relativePathInsideRoot(ownPath, absolutePath) !== null)
  ) {
    return {
      worktreeId: context.worktreeId,
      worktreePath: ownPath,
      connectionId: context.connectionId,
      environmentId: context.settings?.activeRuntimeEnvironmentId ?? null,
      repo: own
        ? folderRepoOf(state, own)
        : folderRepoOf(state, { repoId: getRepoIdFromWorktreeId(context.worktreeId) })
    }
  }
  if (!absolutePath) {
    return null
  }
  let best: FileWorkspace | null = null
  for (const worktree of Object.values(state.worktreesByRepo ?? {}).flat()) {
    const repo = folderRepoOf(state, worktree)
    if (
      !repo ||
      !isPerforceRepo(repo) ||
      relativePathInsideRoot(worktree.path, absolutePath) === null ||
      (best && best.worktreePath.length >= worktree.path.length)
    ) {
      continue
    }
    best = {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      connectionId: repo.connectionId,
      environmentId: getRuntimeEnvironmentIdForWorktree(state, worktree.id),
      repo
    }
  }
  return best
}

/**
 * The Perforce target for a save or diff of `absolutePath` (or of a file in `context`'s workspace),
 * routed to the host that owns it; null when no Perforce workspace holds the file. A folder project
 * not yet marked Perforce is detected here, so a save made before the sidebar's check still works.
 */
export async function perforceTargetForFile(
  context: RuntimeGitContext,
  absolutePath?: string
): Promise<PerforceWorkspaceTarget | null> {
  const state = useAppStore.getState()
  const workspace = workspaceOfFile(state, context, absolutePath)
  if (!workspace?.repo) {
    return null
  }
  const target = buildTarget(
    workspace.worktreeId,
    workspace.worktreePath,
    workspace.connectionId,
    workspace.environmentId,
    {
      perforce: state.settings?.perforce,
      agentCmdOverrides: state.settings?.agentCmdOverrides,
      defaultTuiAgent: state.settings?.defaultTuiAgent
    }
  )
  if (isPerforceRepo(workspace.repo)) {
    return target
  }
  return (await isPerforceWorkspaceForFiles(target)) ? target : null
}
