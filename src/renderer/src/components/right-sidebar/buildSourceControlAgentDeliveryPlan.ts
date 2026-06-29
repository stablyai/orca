import { planSourceControlAgentActionLaunch } from '@/lib/source-control-agent-action-plan'
import { resolveAgentStartupTarget } from '@/lib/agent-startup-target'
import { useAppStore } from '@/store'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import { repoIsRemote } from '../../../../shared/agent-launch-remote'
import type { Repo, TuiAgent } from '../../../../shared/types'
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
  launchHost?: Pick<Repo, 'connectionId' | 'executionHostId'> | null
  projectRuntime?: ProjectExecutionRuntimeResolution
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
  launchHost,
  projectRuntime,
  isRemote
}: BuildSourceControlAgentDeliveryPlanArgs): SourceControlAgentActionDeliveryPlanState {
  if (connectionUnavailable) {
    return buildSourceControlAgentConnectionErrorPlan()
  }
  const settings = useAppStore.getState().settings
  const startupTarget = resolveAgentStartupTarget({
    platform: launchPlatform,
    host: launchHost,
    terminalWindowsShell: settings?.terminalWindowsShell,
    projectRuntime
  })
  const launchIsRemote = isRemote ?? repoIsRemote(launchHost ?? {})
  const result = planSourceControlAgentActionLaunch({
    agent: selectedAgent,
    commandInput,
    agentArgs,
    promptDelivery,
    detectedAgents,
    disabledAgents: settings?.disabledTuiAgents,
    cmdOverrides: settings?.agentCmdOverrides,
    startupTarget,
    isRemote: launchIsRemote
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
