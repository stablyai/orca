import { toast } from 'sonner'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getProjectGroupHostId } from '@/store/slices/project-group-owner-routing'
import { ERROR_TOAST_DURATION } from '@/store/repos/repo-state'
import { translate } from '@/i18n/i18n'

/** Group an Add Project flow was launched from. Carries the owner host: one store list holds every host's groups, keyed on [host, id]. */
export type AddProjectTarget = {
  groupId: string
  hostId: ExecutionHostId
}

export type AddedProjectGroupAssignmentState = {
  addProjectTarget: AddProjectTarget | null
  projectGroups: readonly ProjectGroup[]
  moveProjectToGroup: (projectId: string, groupId: string | null) => Promise<boolean>
  clearAddProjectTarget: () => void
}

export function addProjectTargetForGroup(
  group: Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>
): AddProjectTarget {
  return { groupId: group.id, hostId: getProjectGroupHostId(group) }
}

export function readAddProjectTarget(data: Record<string, unknown>): AddProjectTarget | null {
  const target = data.addProjectTarget
  if (!target || typeof target !== 'object') {
    return null
  }
  const { groupId, hostId: rawHostId } = target as Partial<AddProjectTarget>
  // Why: the host comparison downstream normalizes both sides, so the target must match.
  const hostId = typeof rawHostId === 'string' ? normalizeExecutionHostId(rawHostId) : null
  if (typeof groupId !== 'string' || !groupId || !hostId) {
    return null
  }
  return { groupId, hostId }
}

/**
 * Moves a project into the group its Add Project flow targeted. The target is consumed on the
 * first attempt so a later, unrelated add cannot inherit it. Callers whose modal closes before
 * the add resolves pass the target explicitly, since closing drops it from the store.
 */
export async function assignAddedProjectToTargetGroup(
  state: AddedProjectGroupAssignmentState,
  repo: Repo,
  explicitTarget?: AddProjectTarget | null
): Promise<void> {
  // Why: fire-and-forget callers discard the promise, so nothing here may reject —
  // not even the failure-reporting path.
  try {
    const target = explicitTarget ?? state.addProjectTarget
    if (!target) {
      return
    }
    // Why: consume before any other exit, or a skipped assignment leaves the target armed
    // for the next unrelated add.
    state.clearAddProjectTarget()
    // Why: re-adding an existing project must keep the group it already has.
    if (repo.projectGroupId) {
      return
    }

    const group = state.projectGroups.find(
      (candidate) =>
        candidate.id === target.groupId && getProjectGroupHostId(candidate) === target.hostId
    )
    if (!group) {
      console.error('[project-group] target group is gone', { target, repoId: repo.id })
      reportAssignmentFailure(
        translate(
          'auto.lib.added-project-group-assignment.groupGone',
          'The group is no longer available'
        ),
        repo
      )
      return
    }

    // Why: moveProjectToGroup routes by the project's host, and a backend that does not know
    // the group silently normalizes it to null while still reporting success.
    const repoHostId = getRepoExecutionHostId(repo)
    if (repoHostId !== target.hostId) {
      console.error('[project-group] cross-host assignment refused', {
        target,
        repoId: repo.id,
        repoHostId
      })
      reportAssignmentFailure(
        translate(
          'auto.lib.added-project-group-assignment.hostMismatch',
          '{{group}} is on a different host',
          { group: group.name }
        ),
        repo
      )
      return
    }

    if (await state.moveProjectToGroup(repo.id, target.groupId)) {
      return
    }
    console.error('[project-group] move rejected', { target, repoId: repo.id })
    reportAssignmentFailure(
      translate(
        'auto.lib.added-project-group-assignment.moveFailed',
        'Could not add the project to {{group}}',
        { group: group.name }
      ),
      repo
    )
  } catch (err) {
    console.error('[project-group] assignment threw', { repoId: repo.id, err })
    try {
      reportAssignmentFailure(
        translate(
          'auto.lib.added-project-group-assignment.unexpected',
          'Could not add the project to the group'
        ),
        repo
      )
    } catch {
      // Why: reporting itself failed; the console.error above is the last resort.
    }
  }
}

function reportAssignmentFailure(message: string, repo: Repo): void {
  toast.error(message, {
    description: translate(
      'auto.lib.added-project-group-assignment.stayedUngrouped',
      '{{project}} was added but stays outside the group.',
      { project: repo.displayName }
    ),
    duration: ERROR_TOAST_DURATION
  })
}
