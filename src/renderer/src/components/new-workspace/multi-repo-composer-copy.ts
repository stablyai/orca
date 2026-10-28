import { translate } from '@/i18n/i18n'
import type { ProjectSetupIneligibleReason } from './resolve-project-setup-for-host'

export type MultiRepoUnavailableReason = ProjectSetupIneligibleReason | 'limit_reached'

/** Visible text for a row or chip that cannot join; never conveyed by color alone. */
export function getMultiRepoUnavailableCopy(
  reason: MultiRepoUnavailableReason,
  hostLabel: string
): string {
  switch (reason) {
    case 'no_setup_on_host':
      return translate(
        'auto.components.newWorkspace.multiRepo.noSetupOnHost',
        'No setup on {{host}}',
        { host: hostLabel }
      )
    case 'direct_ssh':
      return translate(
        'auto.components.newWorkspace.multiRepo.directSshUnsupported',
        "Direct SSH setups don't support multi-repo"
      )
    case 'wsl':
      return translate(
        'auto.components.newWorkspace.multiRepo.wslUnsupported',
        "WSL setups don't support multi-repo"
      )
    case 'folder':
      return translate(
        'auto.components.newWorkspace.multiRepo.folderProject',
        'Folder project, no git worktrees'
      )
    case 'not_ready':
      return translate(
        'auto.components.newWorkspace.multiRepo.setupNotReady',
        'Setup on {{host}} is not ready',
        { host: hostLabel }
      )
    case 'limit_reached':
      return translate(
        'auto.components.newWorkspace.multiRepo.limitReached',
        'A workspace holds at most 12 projects'
      )
  }
}
