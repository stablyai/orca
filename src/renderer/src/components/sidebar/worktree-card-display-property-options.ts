import type { WorktreeCardProperty } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

export const PROPERTY_OPTIONS: { id: WorktreeCardProperty; label: string }[] = [
  {
    id: 'issue',
    get label() {
      return translate(
        'auto.components.sidebar.SidebarWorkspaceOptionsMenu.91dfc653e8',
        'GitHub ticket'
      )
    }
  },
  {
    id: 'linear-issue',
    get label() {
      return translate(
        'auto.components.sidebar.SidebarWorkspaceOptionsMenu.ca4d3c522e',
        'Linear issue'
      )
    }
  },
  {
    id: 'pr',
    get label() {
      return translate(
        'auto.components.sidebar.SidebarWorkspaceOptionsMenu.b8dcc6f321',
        'PR/MR link'
      )
    }
  },
  {
    id: 'automation',
    get label() {
      return translate(
        'auto.components.sidebar.SidebarWorkspaceOptionsMenu.automation',
        'Automation'
      )
    }
  },
  {
    id: 'comment',
    get label() {
      return translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.26c71e536c', 'Notes')
    }
  },
  {
    id: 'ports',
    get label() {
      return translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.b64d8bcca0', 'Ports')
    }
  },
  {
    id: 'inline-agents',
    get label() {
      return translate(
        'auto.components.sidebar.SidebarWorkspaceOptionsMenu.d7084e8bc8',
        'Agent activity'
      )
    }
  }
]
