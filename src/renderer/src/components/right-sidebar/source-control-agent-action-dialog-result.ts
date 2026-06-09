import type { getAgentCatalog } from '@/lib/agent-catalog'
import type { useAppStore } from '@/store'
import type { useRepoById } from '@/store/selectors'
import type { TuiAgent } from '../../../../shared/types'
import type { SourceControlAgentActionDeliveryPlanState } from './SourceControlAgentActionDialogForm'

export type UseSourceControlAgentActionDialogResult = {
  handleOpenChange: (nextOpen: boolean) => void
  agentOptions: ReturnType<typeof getAgentCatalog>
  selectedAgent: TuiAgent | null
  hasEnabledAgents: boolean
  detecting: boolean
  statusCopy: string | null
  agentArgs: string
  commandTemplate: string
  saveLaunchRecipe: boolean
  saveTargetValue: string
  saveTargets: { value: string; label: string }[]
  settings: ReturnType<typeof useAppStore.getState>['settings']
  repo: ReturnType<typeof useRepoById>
  deliveryPlan: SourceControlAgentActionDeliveryPlanState
  canStart: boolean
  isStarting: boolean
  onSelectedAgentChange: (agent: TuiAgent | null) => void
  onAgentArgsChange: (value: string) => void
  onCommandTemplateChange: (value: string) => void
  onSaveLaunchRecipeChange: (value: boolean) => void
  onSaveAgentDefaultChange: (value: string) => void
  handleStart: () => Promise<void>
}
