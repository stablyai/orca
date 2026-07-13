import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  planAgentCliArgsSuffix,
  type AgentStartupPlan
} from '@/lib/tui-agent-startup'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../shared/types'
import { translate } from '@/i18n/i18n'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'

export type SourceControlLaunchPlanDelivery =
  | 'argv'
  | 'draft-native'
  | 'draft-paste'
  | 'paste-submit'

export type SourceControlLaunchPlanResult =
  | {
      ok: true
      plan: AgentStartupPlan
      delivery: SourceControlLaunchPlanDelivery
      commandLabel: string
      summary: string
      caveat: string
    }
  | { ok: false; error: string }

export function planSourceControlAgentActionLaunch(args: {
  agent: TuiAgent | null
  commandInput: string
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  detectedAgents: TuiAgent[]
  disabledAgents?: TuiAgent[]
  cmdOverrides?: Partial<Record<TuiAgent, string>>
  agentArgs?: string | null
  platform?: NodeJS.Platform
  terminalWindowsShell?: string | null
  /** Why: SSH remotes deploy the CLI shim as plain `orca`, so the Linux-only
   * `orca-ide` rename must not be applied for remote launches. */
  isRemote?: boolean
}): SourceControlLaunchPlanResult {
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

  const trimmedInput = args.commandInput.trim()
  if (!trimmedInput) {
    return {
      ok: false,
      error: translate(
        'auto.lib.source.control.agent.action.plan.46f1a2c9bd',
        'Command input is empty.'
      )
    }
  }

  const cmdOverrides = args.cmdOverrides ?? {}
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
  let startupPlan: AgentStartupPlan | null = null
  let delivery: SourceControlLaunchPlanDelivery

  if (args.promptDelivery === 'submit-after-ready') {
    startupPlan = buildAgentStartupPlan({
      agent,
      prompt: '',
      cmdOverrides,
      platform,
      shell,
      isRemote,
      agentArgs: args.agentArgs,
      allowEmptyPromptLaunch: true
    })
    delivery = 'paste-submit'
  } else if (args.promptDelivery === 'draft') {
    const draftLaunchPlan = buildAgentDraftLaunchPlan({
      agent,
      draft: trimmedInput,
      cmdOverrides,
      platform,
      shell,
      isRemote,
      agentArgs: args.agentArgs
    })
    if (draftLaunchPlan) {
      startupPlan = {
        agent: draftLaunchPlan.agent,
        launchCommand: draftLaunchPlan.launchCommand,
        expectedProcess: draftLaunchPlan.expectedProcess,
        followupPrompt: null,
        launchConfig: draftLaunchPlan.launchConfig,
        ...(draftLaunchPlan.startupCommandDelivery
          ? { startupCommandDelivery: draftLaunchPlan.startupCommandDelivery }
          : {}),
        ...(draftLaunchPlan.env ? { env: draftLaunchPlan.env } : {})
      }
      delivery = 'draft-native'
    } else {
      startupPlan = buildAgentStartupPlan({
        agent,
        prompt: '',
        cmdOverrides,
        platform,
        shell,
        isRemote,
        agentArgs: args.agentArgs,
        allowEmptyPromptLaunch: true
      })
      delivery = 'draft-paste'
    }
  } else if (TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start') {
    startupPlan = buildAgentStartupPlan({
      agent,
      prompt: '',
      cmdOverrides,
      platform,
      shell,
      isRemote,
      agentArgs: args.agentArgs,
      allowEmptyPromptLaunch: true
    })
    delivery = 'draft-paste'
  } else {
    startupPlan = buildAgentStartupPlan({
      agent,
      prompt: trimmedInput,
      cmdOverrides,
      platform,
      shell,
      isRemote,
      agentArgs: args.agentArgs,
      allowEmptyPromptLaunch: false
    })
    delivery = 'argv'
  }

  if (!startupPlan) {
    return {
      ok: false,
      error: translate(
        'auto.lib.source.control.agent.action.plan.3f0ea9aa0d',
        'Could not build the agent launch command.'
      )
    }
  }

  const summary =
    delivery === 'paste-submit'
      ? 'The agent starts with no prompt, then Orca pastes and submits the command input after the TUI is ready.'
      : delivery === 'draft-native'
        ? 'The command input is prefilled as an editable draft by the agent launch command.'
        : delivery === 'draft-paste'
          ? 'The agent starts with no prompt, then Orca pastes the command input as an editable draft after the TUI is ready.'
          : 'The command input is included in the launch command and submitted as the first turn.'

  return {
    ok: true,
    plan: startupPlan,
    delivery,
    commandLabel: startupPlan.launchCommand,
    summary,
    caveat:
      'This check builds Orca’s launch plan only. PATH, binary availability, account setup, and terminal startup failures are still caught by the real launch watchdog.'
  }
}
