// Orca Cloud clone failures and the GitHub owner the App must be installed on.
import type { Translate } from '@/i18n/use-translate'

/** `owner/name` → `owner`: the GitHub account or org the App must be installed on. */
export function repoOwner(repoName: string): string {
  const owner = repoName.split('/')[0]?.trim()
  return owner && repoName.includes('/') ? owner : repoName
}

export function cloneFailedBody(reason: string, t: Translate): string {
  switch (reason) {
    case 'clone_timeout':
      return t(
        'auto.components.worktree.creation.VmBuildFailureCard.cloneTimeoutBody',
        'Cloning took longer than 15 minutes, so Orca stopped it and deleted the sandbox. Try again, or contact support if it keeps happening.'
      )
    case 'clone_stalled':
      return t(
        'auto.components.worktree.creation.VmBuildFailureCard.cloneStalledBody',
        'Cloning stopped making progress, so Orca stopped it and deleted the sandbox. Try again in a moment.'
      )
    case 'repo_unreachable':
      return t(
        'auto.components.worktree.creation.VmBuildFailureCard.cloneUnreachableBody',
        'GitHub refused access to this repository. Check that it still exists and that the Orca GitHub App can reach it, then try again. The sandbox was deleted.'
      )
    case 'disk_full':
      return t(
        'auto.components.worktree.creation.VmBuildFailureCard.cloneDiskFullBody',
        'This repository doesn’t fit on the sandbox’s disk. The sandbox was deleted.'
      )
    default:
      return t(
        'auto.components.worktree.creation.VmBuildFailureCard.cloneFailedBody',
        'Git stopped with an error while cloning, and the sandbox was deleted. Try again, or open the logs for details.'
      )
  }
}
