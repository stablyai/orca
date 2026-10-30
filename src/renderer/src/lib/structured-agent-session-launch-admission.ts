import { toast } from 'sonner'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import {
  adoptAgentSessionLaunchVerdict,
  type AgentSessionLaunchPlan
} from '@/lib/agent-session-launch-plan'
import {
  admitStructuredLaunchOnHost,
  type StructuredLaunchAdmission
} from '@/lib/structured-agent-session-host-admission'
import { holdEmptyWorkspaceDefaultSurfaceForLaunch } from '@/lib/empty-workspace-default-surface-claims'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/structured-agent-session-launch-errors'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import type {
  StructuredAgentLaunchHooks,
  StructuredAgentLaunchSettlement
} from '@/lib/structured-agent-launch-settlement'
import type { StructuredPromptDeliveryResult } from '@/lib/structured-agent-session-launch-prompt'
import type { LaunchAgentInNewTabArgs } from '@/lib/launch-agent-in-new-tab'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { readStructuredChatHostPermissionVerdict } from '@/runtime/structured-chat-host-permission'
import { notifyHostPermissionRefused } from '@/lib/structured-agent-session-launch-permission-notice'
import { readAgentInventoryForTarget } from '@/lib/agent-detection-target-inventory'
import { structuredChatUnavailableText } from '@/lib/structured-agent-session-launch-failure'
import type { WebRuntimeTerminalCreateOutcome } from '@/runtime/web-runtime-session-types'

export type AgentTerminalLaunchCompletion = {
  outcome: WebRuntimeTerminalCreateOutcome
  tabId?: string
}

/** What a host's "no" opens instead: the terminal the launch would have opened had it known. */
export type StructuredLaunchTerminal = {
  opened: boolean
  tabId?: string
  completion?: Promise<AgentTerminalLaunchCompletion>
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
}

/** A chat launch its owning host has not admitted yet. Nothing of it exists here until it does. */
export type HostAdmittedStructuredLaunch = {
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
const NOT_DELIVERED_NOTIFIED: StructuredPromptDeliveryResult = {
  delivered: false,
  failureNotified: true
}

function notifyExplicitChatFailure(agent: TuiAgent, reason?: string): void {
  toast.error(
    translate(
      'auto.components.tab.bar.QuickLaunchButton.chatUnavailableAfterSelection',
      "Couldn't start a {{value0}} chat.",
      { value0: structuredAgentLabel(agent) }
    ),
    { description: structuredChatUnavailableText(reason) }
  )
}

export function notifyHostDeclined(agent: TuiAgent, explain = true): void {
  const agentLabel = structuredAgentLabel(agent)
  toast.info(
    translate(
      'components.native-chat.structuredSessionHostDeclined',
      'Opened {{value0}} in a terminal',
      { value0: agentLabel }
    ),
    explain
      ? {
          description: translate(
            'components.native-chat.structuredSessionHostDeclinedDescription',
            "This workspace can't run a {{value0}} chat.",
            { value0: agentLabel }
          )
        }
      : undefined
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
  | 'agentArgs'
  | 'sessionOptionsYieldToAgentArgs'
  | 'launchPlatform'
  | 'launchSource'
  | 'initialCwd'
  | 'activate'
>

/** A caller with no terminal path of its own gets the one a new agent tab would open. */
export async function openDeclinedStructuredLaunchTerminal(args: {
  plan: AgentSessionLaunchPlan
  worktreeId: string
  targetGroupId?: string
  terminal?: DeclinedStructuredLaunchTerminalOptions
}): Promise<StructuredLaunchTerminal> {
  // Loaded late: the new-tab launcher begins these launches.
  const { launchAgentInNewTabWithOutcome } = await import('@/lib/launch-agent-in-new-tab')
  const result = launchAgentInNewTabWithOutcome({
    ...args.terminal,
    agent: args.plan.agent,
    worktreeId: args.worktreeId,
    // The saved choice the chat would have seeded applies to its terminal as flags.
    ...(args.plan.launchOptions ? { sessionOptions: args.plan.launchOptions } : {}),
    ...(args.targetGroupId ? { groupId: args.targetGroupId } : {}),
    ...(args.terminal?.activate !== false && args.plan.prompt ? { prompt: args.plan.prompt } : {}),
    ...(args.plan.promptDelivery ? { promptDelivery: args.plan.promptDelivery } : {}),
    ...(args.plan.onPromptDelivered ? { onPromptDelivered: args.plan.onPromptDelivered } : {}),
    ...(args.plan.promptKeptByCaller ? { promptKeptByCaller: true as const } : {}),
    agentSessionLaunchPlan: adoptAgentSessionLaunchVerdict({
      route: 'terminal-tui',
      requestId: args.plan.requestId,
      agent: args.plan.agent,
      worktreeId: args.worktreeId
    })
  })
  if (result && 'refused' in result) {
    return { opened: false, promptDeliveryResult: Promise.resolve(result.refused) }
  }
  return {
    opened: result !== null,
    ...(result?.surface.kind === 'local-terminal' ? { tabId: result.surface.tabId } : {}),
    ...(result?.terminalCompletion ? { completion: result.terminalCompletion } : {}),
    ...(result?.promptDeliveryResult ? { promptDeliveryResult: result.promptDeliveryResult } : {})
  }
}

/** A declined chat falls back to its agent's terminal only where that CLI may be installed. */
export function declinedTerminalCanOpen(
  agent: TuiAgent,
  worktreeId: string,
  host: ExecutionHostId,
  opensCallerSurface?: true
): boolean {
  if (opensCallerSurface) {
    return true
  }
  const parsed = parseExecutionHostId(host)
  const inventory = readAgentInventoryForTarget(
    useAppStore.getState(),
    parsed?.kind === 'ssh'
      ? { kind: 'ssh', connectionId: parsed.targetId }
      : parsed?.kind === 'runtime'
        ? { kind: 'runtime', environmentId: parsed.environmentId, worktreeId }
        : { kind: 'local', worktreeId }
  )
  return inventory.state !== 'successful' || inventory.ids?.includes(agent) !== false
}

/** Ask the executing host before creating tabs/records/prompts/focus intent. Admission opens chat; refusal uses caller terminal (resume without equivalent fails); unreachable server opens nothing. Local unable-to-answer/unresolvable opens chat for its own create to report. */
export function beginHostAdmittedStructuredLaunch(args: {
  plan: AgentSessionLaunchPlan & { agent: TuiAgent }
  hooks: StructuredAgentLaunchHooks
  worktreeId: string
  executionHostId: ExecutionHostId
  target: RuntimeClientTarget
  /** Commits the admitted chat: the local launch path, told which host admitted it and the saved
   *  selection that host said create will seed. */
  openAdmitted: (seedOptions?: Readonly<Record<string, string>>) => AdmittedLaunch | null
  /** Told which host declined, since where its terminal opens can depend on it. */
  onHostDeclined: (
    target: RuntimeClientTarget
  ) => Promise<StructuredLaunchTerminal> | StructuredLaunchTerminal
  /** `onHostDeclined` opens the caller's own surface (a shell), never the agent's CLI. */
  declinedOpensCallerSurface?: true
}): HostAdmittedStructuredLaunch {
  const { plan } = args
  const paired = args.target.kind === 'environment'
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
  // Notifies for an explicit chat that carries a prompt (one without opens before its host answers,
  // and its chat says why) or a default agent with no CLI to fall back to.
  const failBeforeSurface = (
    error: unknown,
    reason?: string,
    notify = plan.requestedSurface === 'chat'
  ): StructuredAgentLaunchSettlement => {
    if (notify && !admitted) {
      notifyExplicitChatFailure(plan.agent, reason)
      resolveDelivery(NOT_DELIVERED_NOTIFIED)
      return { kind: 'failed', error, notified: true }
    }
    resolveDelivery(NOT_DELIVERED)
    return { kind: 'failed', error }
  }
  // Released once the surface that answers the launch has opened, or nothing will.
  const releaseHold = holdEmptyWorkspaceDefaultSurfaceForLaunch(args.worktreeId)
  const settlement = (async (): Promise<StructuredAgentLaunchSettlement> => {
    try {
      const asked = await admitStructuredLaunchOnHost(
        args.target,
        toRuntimeWorktreeSelector(args.worktreeId),
        plan.agent
      )
      if (isCancelled()) {
        resolveDelivery(NOT_DELIVERED)
        return { kind: 'cancelled', sessionId: null }
      }
      // Unresolvable servers keep terminal fallback; local unable-to-answer can safely defer reporting to chat create.
      const admission: StructuredLaunchAdmission =
        asked.kind !== 'workspace-unresolved'
          ? asked
          : paired
            ? { kind: 'declined' }
            : { kind: 'unreachable' }
      if (admission.kind === 'unreachable' && paired) {
        notifyHostUnreachable(plan.agent, args.executionHostId)
        resolveDelivery({ delivered: false, failureNotified: true })
        return {
          kind: 'failed',
          error: new Error('structured chat host unreachable'),
          notified: true
        }
      }
      if (admission.kind === 'declined') {
        const noCli = !declinedTerminalCanOpen(
          plan.agent,
          args.worktreeId,
          args.executionHostId,
          args.declinedOpensCallerSurface
        )
        if (plan.resumeFrom || plan.requestedSurface === 'chat' || noCli) {
          return failBeforeSurface(
            new StructuredAgentSessionCreateRefusalError('structured_agent_session_unsupported'),
            admission.reason,
            plan.requestedSurface === 'chat' || noCli
          )
        }
        const terminal = await args.onHostDeclined(args.target)
        if (paired && terminal.opened) {
          notifyHostDeclined(plan.agent)
        }
        void (
          terminal.promptDeliveryResult ??
          Promise.resolve(terminal.opened ? DELIVERED : NOT_DELIVERED)
        ).then(resolveDelivery, () => resolveDelivery(NOT_DELIVERED))
        return terminal.opened ? { kind: 'terminal' } : { kind: 'cancelled', sessionId: null }
      }
      // A host that would run the chat with more access than asked for gets nothing to start.
      const permission = paired
        ? await readStructuredChatHostPermissionVerdict(args.target, plan.agent)
        : { kind: 'allowed' as const }
      if (isCancelled()) {
        resolveDelivery(NOT_DELIVERED)
        return { kind: 'cancelled', sessionId: null }
      }
      if (permission.kind !== 'allowed') {
        notifyHostPermissionRefused(plan.agent, permission.kind)
        resolveDelivery({ delivered: false, failureNotified: true })
        return {
          kind: 'failed',
          error: new Error('structured chat host runs with more access than asked for'),
          notified: true
        }
      }
      admitted = args.openAdmitted(
        admission.kind === 'admitted' ? admission.seedOptions : undefined
      )
      if (!admitted) {
        resolveDelivery(NOT_DELIVERED)
        return { kind: 'cancelled', sessionId: null }
      }
      void (admitted.promptDeliveryResult ?? Promise.resolve(DELIVERED)).then(resolveDelivery, () =>
        resolveDelivery(NOT_DELIVERED)
      )
      return admitted.settlement
    } finally {
      releaseHold()
    }
  })().catch(failBeforeSurface)
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
