import type { ProjectHostSetup } from '../../../shared/project-types'

export function getPendingSetupDetail(setup: ProjectHostSetup): string {
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
