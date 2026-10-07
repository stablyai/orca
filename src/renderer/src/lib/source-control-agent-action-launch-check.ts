import { buildAgentStartupPlan, planAgentCliArgsSuffix } from '@/lib/tui-agent-startup'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../shared/tui-agent'
import { translate } from '@/i18n/i18n'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'

/**
 * What the source-control dialog checks before it starts an agent: what the user can fix here (the
 * agent, its arguments, the input). How the prompt then reaches the agent is the host's to decide
 * (`agent.launch`), so nothing here predicts it.
 */
export type SourceControlLaunchCheckResult = { ok: true } | { ok: false; error: string }

export function checkSourceControlAgentActionLaunch(args: {
  agent: TuiAgent | null
  commandInput: string
  detectedAgents: TuiAgent[]
  disabledAgents?: TuiAgent[]
  cmdOverrides?: Partial<Record<TuiAgent, string>>
  agentArgs?: string | null
  platform?: NodeJS.Platform
  terminalWindowsShell?: string | null
  /** Why: SSH remotes deploy the CLI shim as plain `orca`, so the Linux-only
   * `orca-ide` rename must not be applied for remote launches. */
  isRemote?: boolean
}): SourceControlLaunchCheckResult {
  const agent = args.agent
  if (!agent) {
    return {
      ok: false,
      error: translate(
        'auto.lib.source.control.agent.action.plan.a7ac8717c7',
        'Choose an agent before starting.'
      )
    }
  }
  if (!isTuiAgentEnabled(agent, args.disabledAgents)) {
    return {
      ok: false,
      error: translate(
        'auto.lib.source.control.agent.action.plan.b96e091fc9',
        'The selected agent is disabled in Settings.'
      )
    }
  }
  if (!args.detectedAgents.includes(agent)) {
    return {
      ok: false,
      error: translate(
        'auto.lib.source.control.agent.action.plan.8eb541cc83',
        'The selected agent was not detected on this workspace host.'
      )
    }
  }

  if (!args.commandInput.trim()) {
    return {
      ok: false,
      error: translate(
        'auto.lib.source.control.agent.action.plan.46f1a2c9bd',
        'Command input is empty.'
      )
    }
  }

  const platform = args.platform ?? CLIENT_PLATFORM
  const isRemote = args.isRemote ?? false
  const shell =
    resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote,
      terminalWindowsShell: args.terminalWindowsShell
    }) ?? (platform === 'win32' ? 'powershell' : 'posix')
  const plannedArgs = planAgentCliArgsSuffix(args.agentArgs, shell)
  if (!plannedArgs.ok) {
    return { ok: false, error: plannedArgs.error }
  }
  // The agent's own command, prompt aside: an override or arguments it cannot build are the user's.
  const launchable = buildAgentStartupPlan({
    agent,
    prompt: '',
    cmdOverrides: args.cmdOverrides ?? {},
    platform,
    shell,
    isRemote,
    agentArgs: args.agentArgs,
    allowEmptyPromptLaunch: true
  })
  if (!launchable) {
    return {
      ok: false,
      error: translate(
        'auto.lib.source.control.agent.action.plan.3f0ea9aa0d',
        'Could not build the agent launch command.'
      )
    }
  }
  return { ok: true }
}
