/** The terminal a new workspace's chat becomes when its host cannot run it, as the ordinary planners
 *  build it. The window plans it at handoff for an accepted launch; a host compiles a prepared launch's
 *  recipe with the released first-turn choices only when that terminal is actually needed. One body
 *  serves both, so a changed model or effort replaces the planner's generated flags while a user's own
 *  command head, unrelated arguments, environment and draft survive as they were planned. */

import type { AgentLaunchTerminalStartupParams } from '../../rpc-contract/agent-launch-accept-params'
import {
  agentStartupPlanInputsFromParams,
  type AgentLaunchTerminalAlternativeParams
} from '../../rpc-contract/agent-launch-release-params'
import type { SessionOptionValue } from '../../native-chat/input/native-chat-session-options'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../permissions/agent-chat-permission-mode'
import type { AgentStartupPlanInputs } from './agent-startup-plan-inputs'
import {
  draftLaunchStartupPlan,
  planLaunchAgentStartupPrompt,
  type LaunchAgentStartupPromptPlan
} from './launch-agent-startup-prompt-plan'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'
import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  type AgentStartupPlan
} from './tui-agent-startup'
import { resolveStartupShell } from './tui-agent-startup-shell'

type CommandStartup = Extract<AgentLaunchTerminalStartupParams, { kind: 'command' }>
type CommandFields = Omit<CommandStartup, 'kind' | 'prompt'>
type Disposition = CommandStartup['prompt']

/** How one key of an ordinary startup plan reaches the host's terminal. `carried`: under its own
 *  name, which the command arm must take with the same type; `carried-local`: only where this
 *  machine's ordinary terminal consumes it; `command`: it is the command. The rest name why the key
 *  is not sent, and what stands in for it on the host. */
type Treatment<K extends keyof AgentStartupPlan> =
  | (K extends keyof CommandFields
      ? NonNullable<AgentStartupPlan[K]> extends NonNullable<CommandFields[K]>
        ? 'carried' | 'carried-local'
        : never
      : never)
  | (K extends 'launchCommand' ? 'command' : never)
  | 'host-derived'
  | 'host-minted'
  | 'resolved-into-command'
  | 'delivered-by-plan'
  | 'not-forwarded'

/** Every key of a startup plan: a key added to the plan fails to compile until classified. */
type Classification = { [K in keyof Required<AgentStartupPlan>]: Treatment<K> }

const SHARED_TREATMENT = {
  launchCommand: 'command',
  // The host still lays the selected account's environment over it.
  env: 'carried',
  launchConfig: 'carried',
  startupCommandDelivery: 'carried',
  // The host starts the launch's agent, the one this plan was built for.
  agent: 'host-derived',
  // The host's terminal create mints one for a configured launch, as the ordinary create does.
  launchToken: 'host-minted',
  // The new-tab and paired handoffs never forward it either.
  expectedProcess: 'not-forwarded',
  // Built from the launch's choices, whose flags the command already holds.
  sessionOptions: 'resolved-into-command'
} as const

/** In view: the new-tab launcher's plan, whose paste-after-launch decision is the one delivery. */
const FOREGROUND_STARTUP = {
  ...SHARED_TREATMENT,
  followupPrompt: 'delivered-by-plan',
  draftPrompt: 'delivered-by-plan'
} as const satisfies Classification

/** Out of view: the creation's quick plan, its own draft pasted unsent on this machine; a paired
 *  workspace's after-wake terminal never has one. */
const BACKGROUND_STARTUP = {
  ...SHARED_TREATMENT,
  followupPrompt: 'delivered-by-plan',
  draftPrompt: 'carried-local'
} as const satisfies Classification

/** The command arm's fields, exactly those the classification sends. */
function classifiedStartup(
  plan: AgentStartupPlan,
  classes: Classification,
  local: boolean
): CommandFields {
  const fields: Record<string, unknown> = {}
  for (const [key, treatment] of Object.entries(classes)) {
    const value: unknown = Reflect.get(plan, key)
    if (value === undefined || value === null) {
      continue
    }
    if (treatment === 'command') {
      fields.command = value
    } else if (treatment === 'carried' || (treatment === 'carried-local' && local)) {
      fields[key] = value
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Classification admits carried keys only where the command arm takes that type, and every plan has a required command.
  return fields as CommandFields
}

/** The quick composer's plan: a draft-prefilled launch when the agent takes one, otherwise its
 *  ordinary startup with the draft kept to paste unsent. */
export function planQuickAgentStartup(
  inputs: AgentStartupPlanInputs,
  prompt: string,
  draftPrompt: string | null | undefined
): AgentStartupPlan | null {
  const draftLaunchPlan = draftPrompt
    ? buildAgentDraftLaunchPlan({ ...inputs, draft: draftPrompt })
    : null
  if (draftLaunchPlan) {
    return draftLaunchStartupPlan(draftLaunchPlan)
  }
  const startupPlan = buildAgentStartupPlan({ ...inputs, prompt, allowEmptyPromptLaunch: true })
  if (startupPlan && draftPrompt) {
    startupPlan.draftPrompt = draftPrompt
  }
  return startupPlan
}

/** In view: a new agent tab with the held message at the end, delivered as the planner decided. */
export function foregroundTerminalStartup(
  planned: LaunchAgentStartupPromptPlan,
  heldText: string
): CommandStartup | undefined {
  const plan = planned.startupPlan
  if (!plan) {
    return undefined
  }
  const disposition: Disposition = !heldText
    ? 'none'
    : planned.pasteDraftAfterLaunch === null
      ? 'carried'
      : planned.submitPastedPrompt
        ? 'submit'
        : 'draft'
  return {
    kind: 'command',
    ...classifiedStartup(plan, FOREGROUND_STARTUP, false),
    prompt: disposition
  }
}

/** Out of view: the submit-time quick plan runs unchanged; a message held during creation stays
 *  unsent in this machine's terminal unless the plan has its own draft, and a paired workspace's
 *  after-wake terminal takes neither. */
export function backgroundTerminalStartup(
  plan: AgentStartupPlan,
  heldText: string,
  held: boolean,
  local: boolean
): CommandStartup {
  const disposition: Disposition = !heldText.trim()
    ? 'none'
    : held
      ? local && !plan.draftPrompt
        ? 'draft'
        : 'none'
      : plan.followupPrompt
        ? 'none'
        : 'carried'
  return {
    kind: 'command',
    ...classifiedStartup(plan, BACKGROUND_STARTUP, local),
    prompt: disposition
  }
}

/** The first turn's final choices as the terminal planner reads them. Replacing the model selection
 *  keeps only the planned permission, as a chat created in that mode does. */
function withReleasedChoices(
  base: AgentStartupPlanInputs,
  choices: Readonly<Record<string, string>>,
  replaceModelSelection: boolean
): AgentStartupPlanInputs {
  if (!replaceModelSelection && Object.keys(choices).length === 0) {
    return base
  }
  const planned: Record<string, SessionOptionValue> = replaceModelSelection
    ? Object.fromEntries(
        Object.entries(base.sessionOptions ?? {}).filter(
          ([key]) => key === AGENT_CHAT_PERMISSION_MODE_OPTION_ID
        )
      )
    : { ...base.sessionOptions }
  const sessionOptions = { ...planned, ...choices }
  const { sessionOptions: _planned, ...rest } = base
  return Object.keys(sessionOptions).length > 0
    ? { ...rest, sessionOptions, sessionOptionsOverrideAgentArgs: true }
    : { ...rest, sessionOptionsOverrideAgentArgs: base.sessionOptionsOverrideAgentArgs }
}

/** Why the planners gave no plan, when the compiler refuses these choices: they contradict a literal
 *  command the user wrote, whose own words say how to fix it. */
function refusedPlan(base: AgentStartupPlanInputs): CompiledAgentLaunchTerminal | null {
  const compiled = resolveAgentLaunchCommand({
    ...base,
    shell: resolveStartupShell(base.platform, base.shell)
  })
  return compiled.ok ? null : { ok: false, error: compiled.error }
}

export type CompiledAgentLaunchTerminal =
  | { ok: true; startup?: AgentLaunchTerminalStartupParams }
  /** The choices contradict a literal command the user wrote; its own words say how to fix it. */
  | { ok: false; error: string }

/** A prepared launch's terminal alternative with its released choices, compiled by the ordinary
 *  planners. `heldText` is the launch's own held message. */
export function compileAgentLaunchTerminalAlternative(args: {
  alternative: AgentLaunchTerminalAlternativeParams
  heldText: string
  choices: Readonly<Record<string, string>>
  replaceModelSelection: boolean
}): CompiledAgentLaunchTerminal {
  const { alternative } = args
  if (alternative.kind === 'none') {
    return { ok: true }
  }
  if (alternative.kind === 'agent') {
    return { ok: true, startup: alternative }
  }
  const base = withReleasedChoices(
    agentStartupPlanInputsFromParams(alternative.base),
    args.choices,
    args.replaceModelSelection
  )
  const { policy } = alternative
  if (policy.kind === 'foreground') {
    const heldText = args.heldText.trim()
    const planned = planLaunchAgentStartupPrompt({
      base,
      prompt: heldText,
      promptDelivery: policy.promptDelivery,
      isFollowupPath: policy.isFollowupPath
    })
    const startup = foregroundTerminalStartup(planned, heldText)
    return startup ? { ok: true, startup } : (refusedPlan(base) ?? { ok: true })
  }
  const plan = planQuickAgentStartup(base, policy.prompt, policy.draftPrompt)
  if (!plan) {
    // A paired workspace starts its agent's own launcher; this machine opens no terminal at all.
    return (
      refusedPlan(base) ??
      (policy.paired ? { ok: true, startup: { kind: 'agent', prompt: 'none' } } : { ok: true })
    )
  }
  return {
    ok: true,
    startup: backgroundTerminalStartup(plan, args.heldText, policy.heldChatMessage, !policy.paired)
  }
}
