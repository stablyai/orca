import type { ProjectHostSetup } from '../../../../../shared/project/project-types'
import type { RepoKind } from '../../../../../shared/repository/repo-types'
import { translate } from '@/i18n/i18n'

export function getNeedsSetupDetail(
  hostLocalKind: RepoKind | null,
  pendingSetup: ProjectHostSetup | undefined
): string {
  if (hostLocalKind === 'folder') {
    return translate(
      'auto.lib.projectHostSetupOptions.hostLocalFolderProject',
      "Folder projects can't link to other hosts"
    )
  }
  if (hostLocalKind === 'git') {
    return translate(
      'auto.lib.projectHostSetupOptions.hostLocalGitProject',
      'No matched Git remote for this project'
    )
  }
  return pendingSetup
    ? getPendingSetupDetail(pendingSetup)
    : translate('auto.lib.projectHostSetupOptions.locationNotSet', 'Project location not set')
}

function getPendingSetupDetail(setup: ProjectHostSetup): string {
  switch (setup.setupState) {
    case 'not-set-up':
      return 'Project tracked on this host but not set up'
    case 'setting-up':
      return 'Project setup is in progress'
    case 'error':
      return 'Project setup needs attention'
    case 'unsupported':
      return 'Project is unsupported on this host'
    case 'ready':
      return setup.path
  }
}
