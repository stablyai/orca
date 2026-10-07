import { toast } from 'sonner'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import {
  adoptAgentSessionLaunchVerdict,
  type AgentSessionLaunchPlan
} from '@/lib/agent-session-launch-plan'
import { admitStructuredLaunchOnHost } from '@/lib/structured-agent-session-host-admission'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/structured-agent-session-launch-errors'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import type {
  StructuredAgentLaunchHooks,
  StructuredAgentLaunchSettlement
} from '@/lib/structured-agent-launch-settlement'
import type { StructuredPromptDeliveryResult } from '@/lib/structured-agent-session-launch-prompt'
import type { LaunchAgentInNewTabArgs } from '@/lib/launch-agent-in-new-tab'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'

/** What a host's "no" opens instead: the terminal the launch would have opened had it known. */
export type StructuredLaunchTerminal = {
  opened: boolean
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
}

/** A chat launch on a paired server. Nothing of it exists here until the server admits it. */
export type PairedStructuredLaunch = {
  sessionId: null
  tab: null
  settlement: Promise<StructuredAgentLaunchSettlement>
  /** Settles from whichever surface received the prompt, or as a notified failure. */
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
  cancel: () => void
}

type AdmittedLaunch = {
  settlement: Promise<StructuredAgentLaunchSettlement>
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
  cancel: () => void
}

const DELIVERED: StructuredPromptDeliveryResult = { delivered: true, failureNotified: false }
const NOT_DELIVERED: StructuredPromptDeliveryResult = { delivered: false, failureNotified: false }

function notifyHostDeclined(agent: TuiAgent): void {
  const agentLabel = structuredAgentLabel(agent)
  toast.info(
    translate(
      'components.native-chat.structuredSessionHostDeclined',
      'Opened {{value0}} in a terminal',
      { value0: agentLabel }
    ),
    {
      description: translate(
        'components.native-chat.structuredSessionHostDeclinedDescription',
        "This server can't run a {{value0}} chat in this workspace.",
        { value0: agentLabel }
      )
    }
  )
}

function notifyHostUnreachable(agent: TuiAgent, executionHostId: ExecutionHostId): void {
  const hostLabel = selectExecutionHostDisplayLabel(useAppStore.getState(), executionHostId)
  toast.error(
    translate(
      'components.native-chat.structuredSessionHostUnreachable',
      'Could not reach {{value0}}',
      {
        value0: hostLabel
      }
    ),
    {
      description: translate(
        'components.native-chat.structuredSessionHostUnreachableDescription',
        'Orca did not open a {{value0}} chat. Check the connection to the server and try again.',
        { value0: structuredAgentLabel(agent) }
      )
    }
  )
}

/** What the caller's own terminal launch would have carried beyond the plan's agent and prompt. */
export type DeclinedStructuredLaunchTerminalOptions = Pick<
  LaunchAgentInNewTabArgs,
  'agentArgs' | 'launchPlatform' | 'launchSource' | 'initialCwd'
>

/** A caller with no terminal path of its own gets the one a new agent tab would open. */
export async function openDeclinedStructuredLaunchTerminal(args: {
  plan: AgentSessionLaunchPlan
  worktreeId: string
  targetGroupId?: string
  terminal?: DeclinedStructuredLaunchTerminalOptions
}): Promise<StructuredLaunchTerminal> {
  // Loaded late: the new-tab launcher begins these launches.
  const { launchAgentInNewTab } = await import('@/lib/launch-agent-in-new-tab')
  const result = launchAgentInNewTab({
    ...args.terminal,
    agent: args.plan.agent,
    worktreeId: args.worktreeId,
    ...(args.targetGroupId ? { groupId: args.targetGroupId } : {}),
    ...(args.plan.prompt ? { prompt: args.plan.prompt } : {}),
    ...(args.plan.promptDelivery ? { promptDelivery: args.plan.promptDelivery } : {}),
    ...(args.plan.onPromptDelivered ? { onPromptDelivered: args.plan.onPromptDelivered } : {}),
    agentSessionLaunchPlan: adoptAgentSessionLaunchVerdict({
      route: 'terminal-tui',
      requestId: args.plan.requestId,
      agent: args.plan.agent,
      worktreeId: args.worktreeId
    })
  })
  return {
    opened: result !== null,
    ...(result?.promptDeliveryResult ? { promptDeliveryResult: result.promptDeliveryResult } : {})
  }
}

/**
 * Asks the paired server that would run a chat before committing any of it here: no tab, launch
 * record, queued prompt or focus intent exists until it answers. Admitted opens the chat as a local
 * launch would; declined opens the caller's terminal with a notice (a resume, which has no terminal
 * equivalent, fails); unreachable opens nothing and says so. There is nothing to undo either way.
 */
export function beginPairedStructuredLaunch(args: {
  plan: AgentSessionLaunchPlan & { agent: TuiAgent }
  hooks: StructuredAgentLaunchHooks
  worktreeId: string
  executionHostId: ExecutionHostId
  target: RuntimeClientTarget
  /** Commits the admitted chat: the local launch path, told which host admitted it and the saved
   *  selection that host said create will seed. */
  openAdmitted: (seedOptions?: Readonly<Record<string, string>>) => AdmittedLaunch | null
  onHostDeclined: () => Promise<StructuredLaunchTerminal> | StructuredLaunchTerminal
}): PairedStructuredLaunch {
  const { plan } = args
  let cancelled = false
  let admitted: AdmittedLaunch | null = null
  const isCancelled = (): boolean => cancelled || args.hooks.signal?.aborted === true
  let resolveDelivery: (result: StructuredPromptDeliveryResult) => void = () => undefined
  const deliversPrompt = Boolean(plan.prompt?.trim()) && plan.promptDelivery !== 'draft'
  const promptDeliveryResult = deliversPrompt
    ? new Promise<StructuredPromptDeliveryResult>((resolve) => {
        resolveDelivery = resolve
      })
    : undefined
  const settlement = (async (): Promise<StructuredAgentLaunchSettlement> => {
    const admission = await admitStructuredLaunchOnHost(
      args.target,
      toRuntimeWorktreeSelector(args.worktreeId),
      plan.agent
    )
    if (isCancelled()) {
      resolveDelivery(NOT_DELIVERED)
      return { kind: 'cancelled', sessionId: null }
    }
    if (admission.kind === 'unreachable') {
      notifyHostUnreachable(plan.agent, args.executionHostId)
      resolveDelivery({ delivered: false, failureNotified: true })
      return {
        kind: 'failed',
        error: new Error('structured chat host unreachable'),
        notified: true
      }
    }
    if (admission.kind === 'declined') {
      if (plan.resumeFrom) {
        resolveDelivery(NOT_DELIVERED)
        return {
          kind: 'failed',
          error: new StructuredAgentSessionCreateRefusalError(
            'structured_agent_session_unsupported'
          )
        }
      }
      notifyHostDeclined(plan.agent)
      const terminal = await args.onHostDeclined()
      void (
        terminal.promptDeliveryResult ??
        Promise.resolve(terminal.opened ? DELIVERED : NOT_DELIVERED)
      ).then(resolveDelivery, () => resolveDelivery(NOT_DELIVERED))
      return terminal.opened ? { kind: 'terminal' } : { kind: 'cancelled', sessionId: null }
    }
    admitted = args.openAdmitted(admission.seedOptions)
    if (!admitted) {
      resolveDelivery(NOT_DELIVERED)
      return { kind: 'cancelled', sessionId: null }
    }
    void (admitted.promptDeliveryResult ?? Promise.resolve(DELIVERED)).then(resolveDelivery, () =>
      resolveDelivery(NOT_DELIVERED)
    )
    return admitted.settlement
  })().catch((error: unknown): StructuredAgentLaunchSettlement => {
    resolveDelivery(NOT_DELIVERED)
    return { kind: 'failed', error }
  })
  return {
    sessionId: null,
    tab: null,
    settlement,
    ...(promptDeliveryResult ? { promptDeliveryResult } : {}),
    cancel: () => {
      cancelled = true
      admitted?.cancel()
    }
  }
}
