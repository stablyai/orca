import {
  planSourceControlAgentActionLaunch,
  resolveSourceControlAgentAvailability
} from '@/lib/source-control-agent-action-plan'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { SourceControlAgentActionDeliveryPlanState } from './SourceControlAgentActionDialogForm'
import { buildSourceControlAgentConnectionErrorPlan } from './source-control-agent-action-dialog-support'

type BuildSourceControlAgentDeliveryPlanArgs = {
  selectedAgent: TuiAgent | null
  commandInput: string
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  detectedAgents: TuiAgent[]
  connectionUnavailable: boolean
}

export function buildSourceControlAgentDeliveryPlan({
  selectedAgent,
  commandInput,
  promptDelivery,
  detectedAgents,
  connectionUnavailable
}: BuildSourceControlAgentDeliveryPlanArgs): SourceControlAgentActionDeliveryPlanState {
  if (connectionUnavailable) {
    return buildSourceControlAgentConnectionErrorPlan()
  }
  const settings = useAppStore.getState().settings
  const { baseAgent, availabilityClass } = resolveSourceControlAgentAvailability(
    selectedAgent,
    settings
  )
  const result = planSourceControlAgentActionLaunch({
    agent: selectedAgent,
    baseAgent,
    availabilityClass,
    commandInput,
    promptDelivery,
    detectedAgents,
    disabledAgents: settings?.disabledTuiAgents
  })
  if (!result.ok) {
    return { status: 'error', error: result.error }
  }
  return {
    status: 'success',
    summary: result.summary,
    deliveryLabel: result.deliveryLabel,
    caveat: result.caveat
  }
}
