import type { AgentLaunchPreferences } from '@/components/settings/use-host-agent-launch-preferences'
import { checkSourceControlAgentActionLaunch } from '@/lib/source-control-agent-action-launch-check'
import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { SourceControlAgentActionDeliveryPlanState } from './SourceControlAgentActionDialogForm'
import { buildSourceControlAgentConnectionErrorPlan } from './source-control-agent-action-dialog-support'

type BuildSourceControlAgentDeliveryPlanArgs = {
  settings?: GlobalSettings | null
  agentLaunchPreferences?: AgentLaunchPreferences
  selectedAgent: TuiAgent | null
  commandInput: string
  agentArgs?: string | undefined
  detectedAgents: TuiAgent[]
  connectionUnavailable: boolean
  launchPlatform?: NodeJS.Platform
  /** SSH uses the plain orca shim; validate the command that host will run. */
  isRemote?: boolean
}

export function buildSourceControlAgentDeliveryPlan({
  settings = useAppStore.getState().settings,
  agentLaunchPreferences,
  selectedAgent,
  commandInput,
  agentArgs,
  detectedAgents,
  connectionUnavailable,
  launchPlatform,
  isRemote
}: BuildSourceControlAgentDeliveryPlanArgs): SourceControlAgentActionDeliveryPlanState {
  if (connectionUnavailable) {
    return buildSourceControlAgentConnectionErrorPlan()
  }
  const result = checkSourceControlAgentActionLaunch({
    agent: selectedAgent,
    commandInput,
    agentArgs,
    detectedAgents,
    disabledAgents: (agentLaunchPreferences ?? settings)?.disabledTuiAgents,
    cmdOverrides: settings?.agentCmdOverrides,
    terminalWindowsShell: settings?.terminalWindowsShell,
    platform: launchPlatform,
    isRemote
  })
  return result.ok ? { status: 'idle' } : { status: 'error', error: result.error }
}
