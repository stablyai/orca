import type { GlobalSettings } from './global-settings-types'
import type { SessionOptionValue } from './native-chat-session-options'
import type { TuiAgent } from './tui-agent'
import { agentDefaultsToIncognito } from './tui-agent-incognito'
import {
  resolveAgentStartupPlanInputs,
  type AgentStartupSettings
} from './agent-startup-plan-inputs'
import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  type AgentDraftLaunchPlan,
  type AgentStartupPlan
} from './tui-agent-startup'

/** Settings a launch reads, plus the incognito-agent list this helper classifies against. */
export type IncognitoAwareStartupSettings = AgentStartupSettings &
  Pick<GlobalSettings, 'terminalIncognitoAgents'>

/**
 * The single launch-command assembler for host builders that bypass resolveAgentTerminalCreateOptions
 * (the structured-session and mobile paths). It resolves the terminal's incognito-by-default state
 * from the agent + Settings.terminalIncognitoAgents and threads it into the shared plan builder, so a
 * capable incognito agent's launch command carries its native `--no-session`. Routing both builders
 * through here is the behavioral guarantee that each threads incognito — no source census needed.
 */
export function buildIncognitoAwareAgentStartupPlan(args: {
  agent: TuiAgent
  settings: IncognitoAwareStartupSettings
  platform: NodeJS.Platform
  isRemote: boolean
  agentArgs?: string | null
  windowsShellOverride?: string | null
  sessionOptions?: Record<string, SessionOptionValue>
  /** 'draft' seeds the prompt via the draft channel; anything else runs the startup plan. */
  promptDelivery?: string
  prompt?: string
  allowEmptyPromptLaunch?: boolean
}): AgentStartupPlan | AgentDraftLaunchPlan | null {
  const inputs = resolveAgentStartupPlanInputs({
    agent: args.agent,
    settings: args.settings,
    platform: args.platform,
    isRemote: args.isRemote,
    incognito: agentDefaultsToIncognito(args.agent, args.settings.terminalIncognitoAgents),
    ...(args.agentArgs !== undefined ? { agentArgs: args.agentArgs } : {}),
    ...(args.windowsShellOverride !== undefined
      ? { windowsShellOverride: args.windowsShellOverride }
      : {}),
    ...(args.sessionOptions ? { sessionOptions: args.sessionOptions } : {})
  })
  return args.promptDelivery === 'draft'
    ? buildAgentDraftLaunchPlan({ ...inputs, draft: args.prompt ?? '' })
    : buildAgentStartupPlan({
        ...inputs,
        prompt: args.prompt ?? '',
        allowEmptyPromptLaunch: args.allowEmptyPromptLaunch ?? true
      })
}
