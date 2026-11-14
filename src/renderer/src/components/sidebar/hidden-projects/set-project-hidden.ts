import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import type { Repo } from '../../../../../shared/repo-types'
import { repoMatchesHostIdentity } from '@/store/repos/repo-host-identity'

type HiddenTarget = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>

function currentRow(target: HiddenTarget): Repo | undefined {
  const hostId = getRepoExecutionHostId(target)
  return useAppStore
    .getState()
    .repos.find((repo) => repoMatchesHostIdentity(repo, target.id, hostId))
}

async function writeHidden(
  targets: readonly HiddenTarget[],
  hiddenAt: number | null
): Promise<HiddenTarget[]> {
  const { updateRepo } = useAppStore.getState()
  const results = await Promise.all(
    targets.map((target) =>
      updateRepo(target.id, { hiddenAt }, { hostId: getRepoExecutionHostId(target) })
    )
  )
  return targets.filter((_, index) => results[index])
}

/** Undoes only this toast's hide: a copy shown since, or hidden again by a newer hide, is left alone. */
async function undoHide(
  targets: readonly HiddenTarget[],
  hiddenAt: number,
  name: string
): Promise<void> {
  const rows = targets.map(currentRow)
  // Removed meanwhile: nothing is left to show, which is not a failure.
  if (rows.every((row) => row === undefined)) {
    toast.info(
      translate('sidebar.hiddenProjects.undoGone', '{{name}} was removed from Orca.', { name })
    )
    return
  }
  const present = targets.filter((_, index) => rows[index]?.hiddenAt === hiddenAt)
  if ((await writeHidden(present, null)).length < present.length) {
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
  const hiddenAt = hidden ? Date.now() : null
  const written = await writeHidden(targets, hiddenAt)
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
  if (hiddenAt !== null && written.length > 0) {
    toast.success(translate('sidebar.hiddenProjects.hidden', '{{name}} hidden', { name }), {
      description: translate(
        'sidebar.hiddenProjects.hiddenDescription',
        'Its terminals and agents keep running. Show it again from Hidden projects below the list.'
      ),
      action: {
        label: translate('sidebar.hiddenProjects.undo', 'Undo'),
        onClick: () => void undoHide(written, hiddenAt, name)
      }
    })
  }
  return written.length === targets.length
}
