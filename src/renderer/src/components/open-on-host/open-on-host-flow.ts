import { toast } from 'sonner'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getRepoMainWorktreeId } from '../../../../shared/worktree/id'
import { suggestionPathBasename } from '../../../../shared/worktree/naming/worktree-name-suggestion'
import { translate } from '@/i18n/i18n'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import {
  fetchRuntimeGit,
  getRuntimeGitUpstreamStatus
} from '@/runtime/source-control/git/runtime-git-sync-client'
import { useAppStore } from '@/store'
import { findRepoForHost } from '@/store/repos/repo-host-identity'
import { ERROR_TOAST_DURATION } from '@/store/repos/repo-state'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { checkCloneTargetOn } from '../sidebar/project-admission/clone-folder/use-clone-folder-override'
import { getRuntimeDefaultCreateProjectParent } from '../sidebar/project-admission/create/runtime-create-project-parent'
import { resolveDeleteTargetGitContext } from '../sidebar/workspace-actions/deletion/use-delete-worktree-status-hydration'
import { getSuggestedCreatureName } from '../sidebar/workspace-creation/naming/worktree-name-suggestions'
import { resolveHostRemoteBranch, type WorkspaceOnHostPlan } from './open-on-host-branch-plan'
import type { OpenOnHostTarget } from './open-on-host-targets'

export type OpenOnHostLocation =
  | { kind: 'existing'; repoId: string; path: string }
  | { kind: 'clone'; url: string; destination: string; folderName: string }
  | { kind: 'unavailable'; reason: string }

export async function resolveOpenOnHostLocation(
  target: OpenOnHostTarget,
  cloneUrl: string
): Promise<OpenOnHostLocation> {
  if (target.existingSetup) {
    return {
      kind: 'existing',
      repoId: target.existingSetup.repoId,
      path: target.existingSetup.path
    }
  }
  const destination = await getRuntimeDefaultCreateProjectParent(target.environmentId, 15_000)
  const check = await checkCloneTargetOn(
    { kind: 'environment', environmentId: target.environmentId },
    { url: cloneUrl, destination }
  )
  if (!check || check.status === 'free') {
    // Why: '' (older host, no check) lets the host derive the folder from the URL.
    return { kind: 'clone', url: cloneUrl, destination, folderName: check?.folderName ?? '' }
  }
  if (check.suggestedFolderName) {
    return { kind: 'clone', url: cloneUrl, destination, folderName: check.suggestedFolderName }
  }
  return {
    kind: 'unavailable',
    reason: translate(
      'openOnHost.cloneFolderTaken',
      "{{path}} is already used on {{host}}. Set this project's location on {{host}} in Project Settings",
      { path: `${destination}/${check.folderName}`, host: target.label }
    )
  }
}

export type OpenOnHostRequest = {
  projectId: string
  displayName: string
  target: OpenOnHostTarget
  location: Exclude<OpenOnHostLocation, { kind: 'unavailable' }>
  /** Absent for a project open (Goal 1). */
  workspace?: { worktree: Worktree; plan: Extract<WorkspaceOnHostPlan, { kind: 'ready' }> }
}

export type OpenOnHostResult = { worktreeId: string; notice: string | null }

/** Null after a failure it has already toasted. */
export async function runOpenOnHost(request: OpenOnHostRequest): Promise<OpenOnHostResult | null> {
  const { projectId, displayName, target, location, workspace } = request
  const state = useAppStore.getState()
  // setupProjectClone toasts its own failure.
  const hostRepo: Repo | null | undefined =
    location.kind === 'existing'
      ? findRepoForHost(state.repos, location.repoId, { hostId: target.hostId })
      : (
          await state.setupProjectClone({
            projectId,
            hostId: target.hostId,
            url: location.url,
            destination: location.destination,
            ...(location.folderName ? { folderName: location.folderName } : {}),
            displayName
          })
        )?.repo
  if (!hostRepo) {
    return null
  }
  try {
    let remoteBranch: { remoteName: string; branchName: string } | null = null
    if (workspace) {
      const { worktree, plan } = workspace
      const ctx = resolveDeleteTargetGitContext(worktree, useAppStore.getState().repos)
      if (!ctx) {
        throw new Error(
          translate('openOnHost.sourceUnavailable', "Can't reach the host of this workspace")
        )
      }
      if (plan.sync !== 'none') {
        try {
          await useAppStore
            .getState()
            .pushBranch(
              worktree.id,
              worktree.path,
              plan.sync === 'publish',
              ctx.connectionId,
              worktree.pushTarget,
              { runtimeTarget: ctx.target }
            )
        } catch {
          // Why: pushBranch already toasted git's reason (e.g. a rejected diverged push); never open a stale tip.
          return null
        }
      }
      remoteBranch = resolveHostRemoteBranch(
        await getRuntimeGitUpstreamStatus(ctx, worktree.pushTarget),
        worktree.pushTarget
      )
      if (!remoteBranch) {
        throw new Error(
          translate(
            'openOnHost.noRemoteBranch',
            'This branch has no remote branch {{host}} can open',
            {
              host: target.label
            }
          )
        )
      }
    }
    await fetchHostRemote(hostRepo, target, remoteBranch)
    // Project open: no base branch, so the host uses its default base (normally origin/<default>).
    const result = await useAppStore
      .getState()
      .createWorktree(
        hostRepo.id,
        workspace
          ? suggestionPathBasename(workspace.worktree.path)
          : getSuggestedCreatureName(selectWorktreesByRepo(useAppStore.getState())),
        remoteBranch ? `${remoteBranch.remoteName}/${remoteBranch.branchName}` : undefined,
        'inherit',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        remoteBranch?.branchName,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        remoteBranch
          ? { executionHostId: target.hostId, branchIntent: 'open-existing-v2' }
          : { executionHostId: target.hostId, nameWasGenerated: true }
      )
    activateAndRevealWorktree(result.worktree.id, { executionHostId: target.hostId })
    return { worktreeId: result.worktree.id, notice: getNotice(request, result.worktree.head) }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error), {
      duration: ERROR_TOAST_DURATION
    })
    return null
  }
}

async function fetchHostRemote(
  hostRepo: Repo,
  target: OpenOnHostTarget,
  remoteBranch: { remoteName: string; branchName: string } | null
): Promise<void> {
  try {
    await fetchRuntimeGit(
      {
        target: { kind: 'environment', environmentId: target.environmentId },
        worktreeId: getRepoMainWorktreeId(hostRepo),
        worktreePath: hostRepo.path
      },
      remoteBranch && remoteBranch.remoteName !== 'origin' ? remoteBranch : undefined
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/does not appear to be a git repository|No such remote/i.test(message)) {
      throw new Error(
        translate('openOnHost.missingRemote', "{{host}}'s clone has no remote {{remote}}", {
          host: target.label,
          remote: remoteBranch?.remoteName ?? 'origin'
        })
      )
    }
    throw error
  }
}

function getNotice({ target, workspace }: OpenOnHostRequest, hostHead: string): string | null {
  if (!workspace) {
    return null
  }
  const { worktree, plan } = workspace
  if (plan.expectSameHead && hostHead !== worktree.head) {
    return translate(
      'openOnHost.headMismatch',
      "{{host}}'s copy of {{branch}} is at a different commit than this Mac",
      { host: target.label, branch: worktree.branch.replace(/^refs\/heads\//, '') }
    )
  }
  if (plan.localOnlyCommits > 0) {
    return translate(
      'openOnHost.localCommitsStay',
      'Your {{count}} local commits stay on this Mac',
      {
        count: plan.localOnlyCommits
      }
    )
  }
  return null
}
