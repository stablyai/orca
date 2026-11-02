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
import { resolveAgentStartupPlanInputs } from '../../../shared/agent-startup-plan-inputs'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { TuiAgent } from '../../../shared/tui-agent'

export type PlannedHostLaunchTerminal = NonNullable<
  NonNullable<PendingWorktreeCreation['hostLaunch']>['terminal']
>

type Disposition = 'carried' | 'submit' | 'draft' | 'none'

// A declined chat's terminal opened through the new-tab launcher, counted under its default label.
const FOREGROUND_LAUNCH_SOURCE = 'tab_bar_quick_launch'

/** In view, the chat's terminal is a new agent tab planned now with the message held at the end. */
function foregroundTerminal(
  worktreeId: string,
  agent: TuiAgent,
  prompt: string
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
      command: plan.launchCommand,
      ...(plan.env ? { env: plan.env } : {}),
      launchConfig: plan.launchConfig,
      ...(plan.startupCommandDelivery
        ? { startupCommandDelivery: plan.startupCommandDelivery }
        : {}),
      prompt: disposition
    },
    launchSource: FOREGROUND_LAUNCH_SOURCE
  }
}

/** Out of view, the submit-time plan runs unchanged; a message held during creation stays unsent
 *  in this machine's terminal, and a paired one's after-wake terminal takes none. */
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
      command: built.command,
      ...(built.env ? { env: built.env } : {}),
      ...(built.launchConfig ? { launchConfig: built.launchConfig } : {}),
      ...(built.startupCommandDelivery
        ? { startupCommandDelivery: built.startupCommandDelivery }
        : {}),
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
    ? foregroundTerminal(args.worktreeId, args.agent, args.prompt)
    : backgroundTerminal(
        args.request,
        args.prompt,
        Boolean(args.heldChatMessage),
        args.owner.target
      )
}
