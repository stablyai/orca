import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import type { AgentComboboxSurfaceRows } from './agent-combobox-surface-items'

export type DefaultAgentPreference = TuiAgent | 'blank' | null

// Blank Terminal is opt-in; agent-only automation/source-control flows cannot run it or accept null.
export type AgentComboboxSelectionProps =
  | { allowBlankTerminal: true; onValueChange: (agent: TuiAgent | null) => void }
  | { allowBlankTerminal?: false; onValueChange: (agent: TuiAgent) => void }

export type AgentComboboxProps = AgentComboboxSelectionProps & {
  blankLabel?: string
  disabled?: boolean
  agents: AgentCatalogEntry[]
  value: TuiAgent | null
  onOpenManageAgents?: () => void
  /** Saved default used for list indicators and right-click default actions. */
  defaultAgent?: DefaultAgentPreference
  /** Enable default-setting context menus on the selected trigger and list items. */
  onSetDefault?: (agent: DefaultAgentPreference) => void
  triggerClassName?: string
  /** Let the parent submit on Enter from the closed trigger instead of opening the picker. */
  onTriggerEnter?: () => void
  allowNarrowTrigger?: boolean
  /** Clearing is separate from selecting Blank Terminal. */
  clearSelection?: {
    cleared: boolean
    onClear: () => void
  }
  /** Lists the "+" menu's chat and CLI rows instead of `agents`; picks go to `onPick`. */
  surfaceRows?: AgentComboboxSurfaceRows
}
