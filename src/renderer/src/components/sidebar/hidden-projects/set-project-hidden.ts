import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import type { Repo } from '../../../../../shared/repo-types'

/** Hides or shows one host's copy of a project in the sidebar; terminals and agents keep running. */
export async function setProjectHidden(
  repo: Pick<Repo, 'id' | 'displayName' | 'connectionId' | 'executionHostId'>,
  hidden: boolean
): Promise<boolean> {
  const saved = await useAppStore
    .getState()
    .updateRepo(
      repo.id,
      { hiddenAt: hidden ? Date.now() : null },
      { hostId: getRepoExecutionHostId(repo) }
    )
  if (!saved) {
    toast.error(
      hidden
        ? translate(
            'sidebar.hiddenProjects.hideFailed',
            "Couldn't hide {{name}}. Its host may need an Orca update.",
            { name: repo.displayName }
          )
        : translate('sidebar.hiddenProjects.showFailed', "Couldn't show {{name}} again.", {
            name: repo.displayName
          })
    )
    return false
  }
  if (hidden) {
    toast.success(
      translate('sidebar.hiddenProjects.hidden', '{{name}} hidden', { name: repo.displayName }),
      {
        description: translate(
          'sidebar.hiddenProjects.hiddenDescription',
          'Its terminals and agents keep running. Show it again from Hidden projects below the list.'
        ),
        action: {
          label: translate('sidebar.hiddenProjects.undo', 'Undo'),
          onClick: () => void setProjectHidden(repo, false)
        }
      }
    )
  }
  return true
}
