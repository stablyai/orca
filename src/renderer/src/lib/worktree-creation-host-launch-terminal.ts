/** The terminal a new workspace's host launch becomes when its host cannot run the chat: the one
 *  this creation's own terminal path would open, planned by the same planner at handoff, and where
 *  the held message goes in it. The host runs it as given and reports what became of the text. */

import { useAppStore } from '@/store'
import { readAgentLaunchPreferencesForWorktree } from '@/runtime/agent-launch-settings/use-host-agent-launch-preferences'
import { resolveAgentLaunchExecutionContext } from '@/lib/launch-agent-execution-context'
import { planLaunchAgentStartupPrompt } from '@/lib/launch-agent-startup-prompt-plan'
import { declinedTerminalCanOpen } from '@/lib/agent-session/launch/structured-agent-session-launch-admission'
import type {
  PendingWorktreeCreation,
  WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'
import {
  resolveAgentStartupPlanInputs,
  type AgentStartupPlanInputs
} from '../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import { TUI_AGENT_CONFIG } from '../../../shared/agent-launch/catalog/tui-agent-config'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  backgroundTerminalStartup,
  foregroundTerminalStartup
} from '../../../shared/agent-launch/startup/agent-launch-terminal-recipe'
import type {
  AgentLaunchTerminalAlternativeParams,
  AgentStartupPlanInputsParams
} from '../../../shared/rpc-contract/agent-launch-release-params'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'

export type PlannedHostLaunchTerminal = NonNullable<
  NonNullable<PendingWorktreeCreation['hostLaunch']>['terminal']
>

// A declined chat's terminal opened through the new-tab launcher, counted under its default label.
const FOREGROUND_LAUNCH_SOURCE = 'tab_bar_quick_launch'

type ForegroundPlanInputs = Parameters<typeof planLaunchAgentStartupPrompt>[0] & {
  base: AgentStartupPlanInputs
}

/** The new-tab launcher's planner inputs for this workspace, read now; null where it has none. */
function foregroundPlan(
  worktreeId: string,
  agent: TuiAgent,
  prompt: string
): ForegroundPlanInputs | null {
  const store = useAppStore.getState()
  // Nothing is said yet: the host may well run the chat, and only then is the terminal needed.
  const context = resolveAgentLaunchExecutionContext(store, { worktreeId, quiet: true })
  if (!context) {
    return null
  }
  return {
    base: resolveAgentStartupPlanInputs({
      agent,
      settings: {
        ...store.settings,
        agentLaunchChoices: readAgentLaunchPreferencesForWorktree(store, worktreeId)
          .agentLaunchChoices
      },
      platform: context.resolvedLaunchPlatform,
      shell: context.queuedShell,
      isRemote: context.isRemote
    }),
    prompt: prompt.trim(),
    promptDelivery: 'auto-submit',
    isFollowupPath: TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'
  }
}

/** In view, the chat's terminal is a new agent tab planned now with the message held at the end. */
function foregroundTerminal(
  worktreeId: string,
  agent: TuiAgent,
  prompt: string
): PlannedHostLaunchTerminal {
  const inputs = foregroundPlan(worktreeId, agent, prompt)
  if (!inputs) {
    return {}
  }
  const startup = foregroundTerminalStartup(planLaunchAgentStartupPrompt(inputs), inputs.prompt)
  return startup ? { startup, launchSource: FOREGROUND_LAUNCH_SOURCE } : {}
}

/** Out of view, the submit-time plan runs unchanged, its own draft pasted unsent on this machine; a
 *  message held during creation stays unsent in this machine's terminal unless the plan has a draft,
 *  and a paired one's after-wake terminal takes neither. */
function backgroundTerminal(
  request: WorktreeCreationRequest,
  prompt: string,
  held: boolean,
  host: RuntimeClientTarget
): PlannedHostLaunchTerminal {
  const plan = request.startupPlan
  const launchSource = request.quickTelemetry?.launch_source
  const attribution = launchSource ? { launchSource } : {}
  if (!plan) {
    // A paired workspace starts its agent's own launcher; this machine opens no terminal at all.
    return host.kind === 'environment'
      ? { startup: { kind: 'agent', prompt: 'none' }, ...attribution }
      : {}
  }
  return {
    startup: backgroundTerminalStartup(plan, prompt, held, host.kind === 'local'),
    ...attribution
  }
}

/** The planner's inputs as the wire carries them: only the agents a command is set for. */
function startupPlanInputsParams(inputs: AgentStartupPlanInputs): AgentStartupPlanInputsParams {
  const cmdOverrides: Record<string, string> = {}
  for (const [agent, command] of Object.entries(inputs.cmdOverrides)) {
    if (command !== undefined) {
      cmdOverrides[agent] = command
    }
  }
  const { shell, sessionOptions, suppressStartupUpdatePrompt } = inputs
  return {
    agent: inputs.agent,
    cmdOverrides,
    agentArgs: inputs.agentArgs,
    agentEnv: inputs.agentEnv,
    platform: inputs.platform,
    ...(shell ? { shell } : {}),
    isRemote: inputs.isRemote,
    ...(sessionOptions ? { sessionOptions } : {}),
    sessionOptionsOverrideAgentArgs: inputs.sessionOptionsOverrideAgentArgs,
    ...(suppressStartupUpdatePrompt !== undefined ? { suppressStartupUpdatePrompt } : {})
  }
}

/** For a host that takes the first turn's final choices after Setup: not a compiled plan but what
 *  the same planners would compile it from, read now as the plan above is, so the host plans the
 *  terminal with those choices only if it needs one. No settings are read again later. */
function plannedTerminalAlternative(args: {
  request: WorktreeCreationRequest
  worktreeId: string
  agent: TuiAgent
  prompt: string
  heldChatMessage: string | undefined
  foreground: boolean
  owner: { target: RuntimeClientTarget }
}): AgentLaunchTerminalAlternativeParams {
  if (args.foreground) {
    const inputs = foregroundPlan(args.worktreeId, args.agent, args.prompt)
    return inputs
      ? {
          kind: 'planned',
          base: startupPlanInputsParams(inputs.base),
          policy: {
            kind: 'foreground',
            promptDelivery: inputs.promptDelivery,
            isFollowupPath: inputs.isFollowupPath
          }
        }
      : { kind: 'none' }
  }
  const paired = args.owner.target.kind === 'environment'
  const recipe = args.request.startupRecipe
  if (!recipe) {
    // No plan: a paired workspace starts its agent's own launcher, this machine opens none.
    return paired ? { kind: 'agent', prompt: 'none' } : { kind: 'none' }
  }
  return {
    kind: 'planned',
    base: startupPlanInputsParams(recipe.inputs),
    policy: {
      kind: 'background',
      prompt: recipe.prompt,
      ...(recipe.draftPrompt ? { draftPrompt: recipe.draftPrompt } : {}),
      heldChatMessage: Boolean(args.heldChatMessage),
      paired
    }
  }
}

/** `request` is the submit-time request; `prompt` is the message the chat would send first.
 *  `release`: the host takes the planner's inputs rather than its plan. */
export function planWorktreeHostLaunchTerminal(args: {
  request: WorktreeCreationRequest
  worktreeId: string
  agent: TuiAgent
  prompt: string
  heldChatMessage: string | undefined
  foreground: boolean
  owner: { executionHostId: ExecutionHostId; target: RuntimeClientTarget }
  release?: boolean
}): PlannedHostLaunchTerminal {
  // Where the agent's CLI is known missing, a declined chat opens no terminal.
  if (!declinedTerminalCanOpen(args.agent, args.worktreeId, args.owner.executionHostId)) {
    return args.release ? { alternative: { kind: 'none' } } : {}
  }
  if (args.release) {
    const alternative = plannedTerminalAlternative(args)
    const launchSource = args.foreground
      ? FOREGROUND_LAUNCH_SOURCE
      : args.request.quickTelemetry?.launch_source
    return {
      alternative,
      ...(alternative.kind !== 'none' && launchSource ? { launchSource } : {})
    }
  }
  return args.foreground
    ? foregroundTerminal(args.worktreeId, args.agent, args.prompt)
    : backgroundTerminal(
        args.request,
        args.prompt,
        Boolean(args.heldChatMessage),
        args.owner.target
      )
}
