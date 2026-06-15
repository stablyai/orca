import type { AgentActivityDisplayMode, WorktreeCardProperty } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

export const GROUP_BY_OPTIONS = [
  {
    id: 'none',
    get label() {
      return translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.c2c7a45cda', 'None')
    }
  },
  {
    id: 'workspace-status',
    get label() {
      return translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.e029a2d775', 'Status')
    }
  },
  {
    id: 'pr-status',
    get label() {
      return translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.0f9b959b31', 'PR')
    }
  },
  {
    id: 'repo',
    get label() {
      return translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.2170d553cf', 'Project')
    }
  }
] as const

export const CARD_LAYOUT_OPTIONS = [
  {
    id: 'detailed',
    get label() {
      return translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.cc17bd443b', 'Detailed')
    }
  },
  {
    id: 'compact',
    get label() {
      return translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.25105b28cb', 'Compact')
    }
  }
] as const

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

export const AGENT_ACTIVITY_DISPLAY_OPTIONS: {
  id: AgentActivityDisplayMode
  label: string
}[] = [
  {
    id: 'compact',
    get label() {
      return translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.25105b28cb', 'Compact')
    }
  },
  {
    id: 'full',
    get label() {
      return translate(
        'auto.components.sidebar.SidebarWorkspaceOptionsMenu.2a81e07366',
        'Full list'
      )
    }
  }
]

export const SORT_OPTIONS = [
  {
    id: 'name',
    get label() {
      return translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.3728165cdd', 'Name')
    },
    description: null
  },
  {
    id: 'smart',
    get label() {
      return translate(
        'auto.components.sidebar.SidebarWorkspaceOptionsMenu.503462f2b4',
        'Agent Activity'
      )
    },
    get description() {
      return translate(
        'auto.components.sidebar.SidebarWorkspaceOptionsMenu.b759bb87ee',
        'Agents that need attention, then most recent activity.'
      )
    }
  },
  {
    id: 'recent',
    get label() {
      return translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.b451c8b162', 'Recent')
    },
    description: null
  },
  {
    id: 'repo',
    get label() {
      return translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.2170d553cf', 'Project')
    },
    description: null
  },
  {
    id: 'manual',
    get label() {
      return translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.7b316bdd51', 'Manual')
    },
    get description() {
      return translate(
        'auto.components.sidebar.SidebarWorkspaceOptionsMenu.7153d07485',
        'Drag workspaces to arrange them within each group.'
      )
    }
  }
] as const

export const PROJECT_ORDER_OPTIONS = [
  {
    id: 'manual',
    get label() {
      return translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.7b316bdd51', 'Manual')
    },
    get description() {
      return translate(
        'auto.components.sidebar.SidebarWorkspaceOptionsMenu.6664282a7b',
        'Drag projects to arrange them'
      )
    }
  },
  {
    id: 'recent',
    get label() {
      return translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.b451c8b162', 'Recent')
    },
    get description() {
      return translate(
        'auto.components.sidebar.SidebarWorkspaceOptionsMenu.af9249c505',
        'Most recent workspace activity'
      )
    }
  }
] as const
