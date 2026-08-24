import { translate } from '@/i18n/i18n'
import type { WorktreeCardPropertyOption } from './sidebar-workspace-option-items'

export const IDENTITY_WORKTREE_CARD_PROPERTY_OPTIONS: WorktreeCardPropertyOption[] = [
  {
    id: 'project-name',
    properties: ['project-name'],
    get label() {
      return translate(
        'auto.components.sidebar.SidebarWorkspaceOptionsMenu.projectName',
        'Project Name'
      )
    }
  },
  {
    id: 'host-name',
    properties: ['host-name'],
    get label() {
      return translate(
        'auto.components.sidebar.SidebarWorkspaceOptionsMenu.remoteHostname',
        'Remote Hostname'
      )
    }
  }
]
