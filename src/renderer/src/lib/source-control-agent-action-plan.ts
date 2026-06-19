import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  planAgentCliArgsSuffix,
  type AgentStartupPlan
} from '@/lib/tui-agent-startup'
import { draftPlanToStartupPlan } from '@/lib/launch-agent-tab-startup-plan'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import {
  findTuiAgentProfile,
  isTuiAgentProfileDetected,
  resolveTuiAgentBaseAgent
} from '../../../shared/tui-agent-profiles'
import type { TuiAgent, TuiAgentProfile } from '../../../shared/types'
import { translate } from '@/i18n/i18n'

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
  agentProfiles?: readonly TuiAgentProfile[] | null
  agentArgs?: string | null
  platform?: NodeJS.Platform
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
  const profile = findTuiAgentProfile(agent, args.agentProfiles)
  const detectedSet = new Set(args.detectedAgents)
  if (profile ? !isTuiAgentProfileDetected(profile, detectedSet) : !detectedSet.has(agent)) {
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
  const shell = platform === 'win32' ? 'powershell' : 'posix'
  const plannedArgs = planAgentCliArgsSuffix(args.agentArgs, shell)
  if (!plannedArgs.ok) {
    return { ok: false, error: plannedArgs.error }
  }
  let startupPlan: AgentStartupPlan | null = null
  let delivery: SourceControlLaunchPlanDelivery
  const baseAgent = resolveTuiAgentBaseAgent(agent, args.agentProfiles)
  if (!baseAgent) {
    return {
      ok: false,
      error: translate(
        'auto.lib.source.control.agent.action.plan.profile.resolution.failed',
        'Could not resolve the selected agent profile.'
      )
    }
  }
  const commonLaunchArgs = {
    agent,
    cmdOverrides,
    platform,
    agentArgs: args.agentArgs,
    agentProfiles: args.agentProfiles
  }

  if (args.promptDelivery === 'submit-after-ready') {
    startupPlan = buildAgentStartupPlan({
      ...commonLaunchArgs,
      prompt: '',
      allowEmptyPromptLaunch: true
    })
    delivery = 'paste-submit'
  } else if (args.promptDelivery === 'draft') {
    const draftLaunchPlan = buildAgentDraftLaunchPlan({
      ...commonLaunchArgs,
      draft: trimmedInput
    })
    if (draftLaunchPlan) {
      startupPlan = draftPlanToStartupPlan(draftLaunchPlan)
      delivery = 'draft-native'
    } else {
      startupPlan = buildAgentStartupPlan({
        ...commonLaunchArgs,
        prompt: '',
        allowEmptyPromptLaunch: true
      })
      delivery = 'draft-paste'
    }
  } else if (TUI_AGENT_CONFIG[baseAgent].promptInjectionMode === 'stdin-after-start') {
    startupPlan = buildAgentStartupPlan({
      ...commonLaunchArgs,
      prompt: '',
      allowEmptyPromptLaunch: true
    })
    delivery = 'draft-paste'
  } else {
    startupPlan = buildAgentStartupPlan({
      ...commonLaunchArgs,
      prompt: trimmedInput,
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
