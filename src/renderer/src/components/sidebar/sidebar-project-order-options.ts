import { translate } from '@/i18n/i18n'

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
  },
  {
    id: 'attention',
    get label() {
      return translate(
        'auto.components.sidebar.SidebarWorkspaceOptionsMenu.projectOrderAttention',
        'Attention'
      )
    },
    get description() {
      return translate(
        'auto.components.sidebar.SidebarWorkspaceOptionsMenu.projectOrderAttentionDescription',
        'Projects with agents that need you first, then done, then working'
      )
    }
  }
] as const

export function getCompactProjectRowsLabel(): string {
  return translate(
    'auto.components.sidebar.SidebarWorkspaceOptionsMenu.compactProjectRows',
    'One row per project'
  )
}
