import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { RepoSlice } from '@/store/repos/repo-state'

type ProjectGroupMenuMutations = Pick<RepoSlice, 'createProjectGroup' | 'moveProjectToGroup'>

const unconfirmedMoveDescription = (): string =>
  translate(
    'auto.components.sidebar.project-group-menu-actions.moveUnconfirmedDescription',
    "Orca could not confirm the move with the project's host. Recheck the project after reconnecting."
  )

export function reportProjectGroupMoveFailure(): void {
  toast.error(
    translate(
      'auto.components.sidebar.project-group-menu-actions.moveFailed',
      'Failed to move project'
    ),
    { description: unconfirmedMoveDescription() }
  )
}

export async function createProjectGroupFromRepo(
  repo: Repo,
  name: string,
  mutations: ProjectGroupMenuMutations
): Promise<void> {
  const hostId = getRepoExecutionHostId(repo)
  const group = await mutations.createProjectGroup(name, { hostId })
  if (!group) {
    toast.error(
      translate(
        'auto.components.sidebar.project-group-menu-actions.createFailed',
        'Failed to create group'
      ),
      {
        description: translate(
          'auto.components.sidebar.project-group-menu-actions.createFailedDescription',
          "Orca could not confirm the new group with the project's host. Check the connection and try again."
        )
      }
    )
    return
  }

  const moved = await mutations.moveProjectToGroup(repo.id, group.id, undefined, { hostId })
  if (!moved) {
    toast.error(
      translate(
        'auto.components.sidebar.project-group-menu-actions.initialMoveUnconfirmed',
        'Group created, but move was not confirmed'
      ),
      { description: unconfirmedMoveDescription() }
    )
  }
}

export async function moveProjectToGroupFromMenu(
  repo: Repo,
  groupId: string,
  moveProjectToGroup: RepoSlice['moveProjectToGroup']
): Promise<void> {
  const moved = await moveProjectToGroup(repo.id, groupId, undefined, {
    hostId: getRepoExecutionHostId(repo)
  })
  if (!moved) {
    reportProjectGroupMoveFailure()
  }
}

export async function removeProjectFromGroupFromMenu(
  repo: Repo,
  moveProjectToGroup: RepoSlice['moveProjectToGroup']
): Promise<void> {
  const removed = await moveProjectToGroup(repo.id, null, undefined, {
    hostId: getRepoExecutionHostId(repo)
  })
  if (!removed) {
    toast.error(
      translate(
        'auto.components.sidebar.project-group-menu-actions.removeFailed',
        'Failed to remove project from group'
      ),
      {
        description: translate(
          'auto.components.sidebar.project-group-menu-actions.removeFailedDescription',
          "Orca could not confirm the change with the project's host. Recheck the project after reconnecting."
        )
      }
    )
  }
}
