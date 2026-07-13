import { planSourceControlAgentActionLaunch } from '@/lib/source-control-agent-action-plan'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../../shared/types'
import type { SourceControlAgentActionDeliveryPlanState } from './SourceControlAgentActionDialogForm'
import { buildSourceControlAgentConnectionErrorPlan } from './source-control-agent-action-dialog-support'

type BuildSourceControlAgentDeliveryPlanArgs = {
  selectedAgent: TuiAgent | null
  commandInput: string
  agentArgs: string
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  detectedAgents: TuiAgent[]
  connectionUnavailable: boolean
  launchPlatform?: NodeJS.Platform
  /** Why: keep the previewed command label in sync with the real remote launch,
   * which omits the Linux-only `orca-ide` rename for SSH hosts. */
  isRemote?: boolean
}

export function buildSourceControlAgentDeliveryPlan({
  selectedAgent,
  commandInput,
  agentArgs,
  promptDelivery,
  detectedAgents,
  connectionUnavailable,
  launchPlatform,
  isRemote
}: BuildSourceControlAgentDeliveryPlanArgs): SourceControlAgentActionDeliveryPlanState {
  if (connectionUnavailable) {
    return buildSourceControlAgentConnectionErrorPlan()
  }
  const result = planSourceControlAgentActionLaunch({
    agent: selectedAgent,
    commandInput,
    agentArgs,
    promptDelivery,
    detectedAgents,
    disabledAgents: useAppStore.getState().settings?.disabledTuiAgents,
    cmdOverrides: useAppStore.getState().settings?.agentCmdOverrides,
    terminalWindowsShell: useAppStore.getState().settings?.terminalWindowsShell,
    platform: launchPlatform,
    isRemote
  })
  if (!result.ok) {
    return { status: 'error', error: result.error }
  }
  return {
    status: 'success',
    summary: result.summary,
    commandLabel: result.commandLabel,
    caveat: result.caveat
  }
}
