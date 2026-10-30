import type { SelectedSourceControlActionRecipe } from '../../../../shared/source-control-action-selection'
import type { getAgentCatalog } from '@/lib/agent-catalog'
import type { useAppStore } from '@/store'
import type { useRepoById } from '@/store/selectors'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentLaunchSurface } from '@/lib/agent-session-launch-plan'
import type { AgentComboboxSurfaceRows } from '@/components/agent/agent-combobox-surface-items'
import type { SourceControlAgentActionDeliveryPlanState } from './SourceControlAgentActionDialogForm'

export type SourceControlAgentScopeNote = {
  effectiveAgentLabel: string
  globalAgentLabel: string
}

export type UseSourceControlAgentActionDialogResult = {
  handleOpenChange: (nextOpen: boolean) => void
  agentScopeNote: SourceControlAgentScopeNote | null
  agentOptions: ReturnType<typeof getAgentCatalog>
  selectedAgent: TuiAgent | null
  hasEnabledAgents: boolean
  detecting: boolean
  surfaceRows: AgentComboboxSurfaceRows
  statusCopy: string | null
  agentArgs: string
  /** False when this launch would be a structured native chat session, which reads no CLI arguments. */
  agentArgsApply: boolean
  recipe: SelectedSourceControlActionRecipe
  commandTemplate: string
  saveLaunchRecipe: boolean
  saveTargetValue: string
  saveTargets: { value: string; label: string }[]
  settings: ReturnType<typeof useAppStore.getState>['settings']
  repo: ReturnType<typeof useRepoById>
  deliveryPlan: SourceControlAgentActionDeliveryPlanState
  canStart: boolean
  isStarting: boolean
  onAgentPick: (agent: TuiAgent, surface?: AgentLaunchSurface) => void
  onAgentArgsChange: (value: string) => void
  onCommandTemplateChange: (value: string) => void
  onSaveLaunchRecipeChange: (value: boolean) => void
  onSaveAgentDefaultChange: (value: string) => void
  handleStart: () => Promise<void>
}
