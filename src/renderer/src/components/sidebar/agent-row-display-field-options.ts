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
        'auto.components.sidebar.agent.row.display.field.options.532b553f3c',
        'Provider icon'
      )
    }
  },
  {
    id: 'secondary-status',
    get label() {
      return translate(
        'auto.components.sidebar.agent.row.display.field.options.48988dc775',
        'Secondary status'
      )
    }
  },
  {
    id: 'model',
    get label() {
      return translate(
        'auto.components.sidebar.agent.row.display.field.options.345859b152',
        'Model label'
      )
    }
  },
  {
    id: 'relative-time',
    get label() {
      return translate(
        'auto.components.sidebar.agent.row.display.field.options.fc775c8e7a',
        'Relative time'
      )
    }
  }
]
