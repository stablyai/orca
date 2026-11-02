/** The terminal a new workspace's host launch becomes when its host cannot run the chat: the one
 *  this creation's own terminal path would open, planned by the same planner at handoff, and where
 *  the held message goes in it. The host runs it as given and reports what became of the text. */

import { useAppStore } from '@/store'
import { readAgentLaunchPreferencesForWorktree } from '@/components/settings/use-host-agent-launch-preferences'
import { resolveAgentLaunchExecutionContext } from '@/lib/launch-agent-execution-context'
import { planLaunchAgentStartupPrompt } from '@/lib/launch-agent-startup-prompt-plan'
import { buildWorktreeCreationStartupOpt } from '@/lib/worktree-creation-flow-startup'
import { declinedTerminalCanOpen } from '@/lib/agent-session/launch/structured-agent-session-launch-admission'
import type {
  PendingWorktreeCreation,
  WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'
import { resolveAgentStartupPlanInputs } from '../../../shared/agent-startup-plan-inputs'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { AgentLaunchTerminalStartupParams } from '../../../shared/rpc-contract/agent-launch-accept-params'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { AgentStartupPlan } from '../../../shared/tui-agent-startup'
import type { TuiAgent } from '../../../shared/tui-agent'

export type PlannedHostLaunchTerminal = NonNullable<
  NonNullable<PendingWorktreeCreation['hostLaunch']>['terminal']
>

type Disposition = 'carried' | 'submit' | 'draft' | 'none'
type CommandFields = Omit<
  Extract<AgentLaunchTerminalStartupParams, { kind: 'command' }>,
  'kind' | 'prompt'
>

/** How one key of an ordinary startup plan reaches the host's terminal. `carried`: under its own
 *  name, which the command arm must take with the same type; `carried-local`: only where this
 *  machine's ordinary terminal consumes it; `command`: it is the command. The rest name why the key
 *  is not sent, and what stands in for it on the host. */
type Treatment<T, K extends keyof T> =
  | (K extends keyof CommandFields
      ? NonNullable<T[K]> extends NonNullable<CommandFields[K]>
        ? 'carried' | 'carried-local'
        : never
      : never)
  | (K extends 'launchCommand' ? 'command' : never)
  | 'host-derived'
  | 'host-minted'
  | 'excluded'
  | 'not-set'
  | 'resolved-into-command'
  | 'delivered-by-plan'
  | 'not-forwarded'

/** Every key of a startup plan type: a key added to the plan fails to compile until classified. */
type Classification<T> = { [K in keyof Required<T>]: Treatment<T, K> }

/** The background plan, buildWorktreeCreationStartupOpt's output, as its ordinary terminal runs it. */
const BACKGROUND_STARTUP = {
  command: 'carried',
  // The host still lays the selected account's environment over it.
  env: 'carried',
  launchConfig: 'carried',
  startupCommandDelivery: 'carried',
  // This machine's terminal pastes it unsent; a paired workspace's after-wake terminal never has.
  draftPrompt: 'carried-local',
  // The host starts the accepted launch's agent, the one this plan was built for.
  launchAgent: 'host-derived',
  // The host's terminal create mints one for a configured launch, as the ordinary create does.
  launchToken: 'host-minted',
  // The builder's agent_kind/launch_source/request_kind:'new' are what the host's agent_started
  // derives from the agent and the launchSource sent beside this plan.
  telemetry: 'host-derived',
  // Seeded only for Command Code, which no host offers as a chat, so no accepted launch reaches
  // this; revisit when a status-seeding agent gains chat support.
  initialAgentStatus: 'excluded',
  // This builder never sets these.
  resumeProviderSession: 'not-set',
  sessionOptions: 'not-set'
} as const satisfies Classification<WorktreeStartupPayload>

/** The foreground plan, as the new-tab launcher hands it to its terminal. */
const FOREGROUND_STARTUP = {
  launchCommand: 'command',
  env: 'carried',
  launchConfig: 'carried',
  startupCommandDelivery: 'carried',
  agent: 'host-derived',
  launchToken: 'host-minted',
  // The planner's paste-after-launch/submit decision is the one delivery (the disposition below).
  followupPrompt: 'delivered-by-plan',
  draftPrompt: 'delivered-by-plan',
  // The new-tab and paired handoffs never forward it either.
  expectedProcess: 'not-forwarded',
  // Built from this workspace's host launch preferences, whose flags the command already holds.
  sessionOptions: 'resolved-into-command'
} as const satisfies Classification<AgentStartupPlan>

/** The command arm's fields, exactly those the classification sends. */
function classifiedStartup<T extends object>(
  plan: T,
  classes: Classification<T>,
  host: RuntimeClientTarget
): CommandFields {
  const fields: Record<string, unknown> = {}
  for (const [key, treatment] of Object.entries(classes)) {
    const value: unknown = Reflect.get(plan, key)
    if (value === undefined || value === null) {
      continue
    }
    if (treatment === 'command') {
      fields.command = value
    } else if (
      treatment === 'carried' ||
      (treatment === 'carried-local' && host.kind === 'local')
    ) {
      fields[key] = value
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Classification admits carried keys only where the command arm takes that type, and both plans have a required command.
  return fields as CommandFields
}

// A declined chat's terminal opened through the new-tab launcher, counted under its default label.
const FOREGROUND_LAUNCH_SOURCE = 'tab_bar_quick_launch'

/** In view, the chat's terminal is a new agent tab planned now with the message held at the end. */
function foregroundTerminal(
  worktreeId: string,
  agent: TuiAgent,
  prompt: string,
  host: RuntimeClientTarget
): PlannedHostLaunchTerminal {
  const store = useAppStore.getState()
  // Nothing is said yet: the host may well run the chat, and only then is the terminal needed.
  const context = resolveAgentLaunchExecutionContext(store, { worktreeId, quiet: true })
  if (!context) {
    return {}
  }
  const text = prompt.trim()
  const planned = planLaunchAgentStartupPrompt({
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
    prompt: text,
    promptDelivery: 'auto-submit',
    isFollowupPath: TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'
  })
  const plan = planned.startupPlan
  if (!plan) {
    return {}
  }
  const disposition: Disposition = !text
    ? 'none'
    : planned.pasteDraftAfterLaunch === null
      ? 'carried'
      : planned.submitPastedPrompt
        ? 'submit'
        : 'draft'
  return {
    startup: {
      kind: 'command',
      ...classifiedStartup(plan, FOREGROUND_STARTUP, host),
      prompt: disposition
    },
    launchSource: FOREGROUND_LAUNCH_SOURCE
  }
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
  const built = buildWorktreeCreationStartupOpt(request, false)
  const launchSource = request.quickTelemetry?.launch_source
  const attribution = launchSource ? { launchSource } : {}
  if (!built) {
    // A paired workspace starts its agent's own launcher; this machine opens no terminal at all.
    return host.kind === 'environment'
      ? { startup: { kind: 'agent', prompt: 'none' }, ...attribution }
      : {}
  }
  const disposition: Disposition = !prompt.trim()
    ? 'none'
    : held
      ? host.kind === 'local' && !built.draftPrompt
        ? 'draft'
        : 'none'
      : request.startupPlan?.followupPrompt
        ? 'none'
        : 'carried'
  return {
    startup: {
      kind: 'command',
      ...classifiedStartup(built, BACKGROUND_STARTUP, host),
      prompt: disposition
    },
    ...attribution
  }
}

/** `request` is the submit-time request; `prompt` is the message the chat would send first. */
export function planWorktreeHostLaunchTerminal(args: {
  request: WorktreeCreationRequest
  worktreeId: string
  agent: TuiAgent
  prompt: string
  heldChatMessage: string | undefined
  foreground: boolean
  owner: { executionHostId: ExecutionHostId; target: RuntimeClientTarget }
}): PlannedHostLaunchTerminal {
  // Where the agent's CLI is known missing, a declined chat opens no terminal.
  if (!declinedTerminalCanOpen(args.agent, args.worktreeId, args.owner.executionHostId)) {
    return {}
  }
  return args.foreground
    ? foregroundTerminal(args.worktreeId, args.agent, args.prompt, args.owner.target)
    : backgroundTerminal(
        args.request,
        args.prompt,
        Boolean(args.heldChatMessage),
        args.owner.target
      )
}
