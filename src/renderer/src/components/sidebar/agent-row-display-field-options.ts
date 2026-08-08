import type { AgentRowDisplayField } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

export const AGENT_ROW_DISPLAY_FIELD_OPTIONS: {
  id: AgentRowDisplayField
  label: string
}[] = [
  {
    id: 'provider-icon',
    get label() {
      return translate(
        'auto.components.sidebar.SidebarWorkspaceOptionsMenu.agentRowProviderIcon',
        'Provider icon'
      )
    }
  },
  {
    id: 'secondary-status',
    get label() {
      return translate(
        'auto.components.sidebar.SidebarWorkspaceOptionsMenu.agentRowSecondaryStatus',
        'Secondary status'
      )
    }
  },
  {
    id: 'model',
    get label() {
      return translate(
        'auto.components.sidebar.SidebarWorkspaceOptionsMenu.agentRowModel',
        'Model label'
      )
    }
  },
  {
    id: 'relative-time',
    get label() {
      return translate(
        'auto.components.sidebar.SidebarWorkspaceOptionsMenu.agentRowRelativeTime',
        'Relative time'
      )
    }
  }
]
