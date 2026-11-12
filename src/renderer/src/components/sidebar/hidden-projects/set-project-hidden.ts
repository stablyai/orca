import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import type { Repo } from '../../../../../shared/repo-types'
import { repoMatchesHostIdentity } from '@/store/repos/repo-host-identity'

type HiddenTarget = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>

function stillRegistered(target: HiddenTarget): boolean {
  const hostId = getRepoExecutionHostId(target)
  return useAppStore
    .getState()
    .repos.some((repo) => repoMatchesHostIdentity(repo, target.id, hostId))
}

async function writeHidden(
  targets: readonly HiddenTarget[],
  hidden: boolean
): Promise<HiddenTarget[]> {
  const { updateRepo } = useAppStore.getState()
  const results = await Promise.all(
    targets.map((target) =>
      updateRepo(
        target.id,
        { hiddenAt: hidden ? Date.now() : null },
        { hostId: getRepoExecutionHostId(target) }
      )
    )
  )
  return targets.filter((_, index) => results[index])
}

async function undoHide(targets: readonly HiddenTarget[], name: string): Promise<void> {
  // Removed meanwhile: nothing is left to show, which is not a failure.
  const present = targets.filter(stillRegistered)
  if (present.length === 0) {
    toast.info(
      translate('sidebar.hiddenProjects.undoGone', '{{name}} was removed from Orca.', { name })
    )
    return
  }
  if ((await writeHidden(present, false)).length < present.length) {
    toast.error(
      translate('sidebar.hiddenProjects.showFailed', "Couldn't show {{name}} again.", { name })
    )
  }
}

/**
 * Hides or shows the given host copies of one project in the sidebar; terminals and agents keep
 * running. A header spanning hosts passes every copy it shows, so one action and one Undo cover all.
 */
export async function setProjectHidden(
  targets: readonly HiddenTarget[],
  hidden: boolean,
  name: string
): Promise<boolean> {
  const written = await writeHidden(targets, hidden)
  if (written.length < targets.length) {
    toast.error(
      hidden
        ? translate(
            'sidebar.hiddenProjects.hideFailed',
            "Couldn't hide {{name}}. Its host may need an Orca update.",
            { name }
          )
        : translate('sidebar.hiddenProjects.showFailed', "Couldn't show {{name}} again.", { name })
    )
  }
  if (hidden && written.length > 0) {
    toast.success(translate('sidebar.hiddenProjects.hidden', '{{name}} hidden', { name }), {
      description: translate(
        'sidebar.hiddenProjects.hiddenDescription',
        'Its terminals and agents keep running. Show it again from Hidden projects below the list.'
      ),
      action: {
        label: translate('sidebar.hiddenProjects.undo', 'Undo'),
        onClick: () => void undoHide(written, name)
      }
    })
  }
  return written.length === targets.length
}
