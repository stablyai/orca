import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { newAgentLaunchRequestId } from '../../lib/agent-session/launch/routing/agent-launch-request-id'
import { startStructuredAgentLaunch } from '@/lib/agent-session/launch/structured-agent-session-launch'
import { captureStructuredLaunchSurfaceAddress } from '@/lib/agent-session/launch/structured-agent-session-launch-surface'
import type { StructuredLaunchSurfaceAddress } from '@/lib/agent-session/launch/structured-agent-session-launch-record'
import { STRUCTURED_LAUNCH_FORK_UNSUPPORTED_REFUSAL } from '@/lib/agent-session/launch/structured-agent-session-launch-create-call'
import { structuredLaunchFailure } from '@/lib/agent-session/launch/structured-agent-session-launch-failure'
import type { StructuredPromptDeliveryResult } from '@/lib/agent-session/launch/structured-agent-session-launch-prompt'
import { newAgentPromptOutcome } from '@/lib/new-agent-prompt-outcome'
import { hostPermissionRefusedText } from '@/lib/agent-session/launch/structured-agent-session-launch-permission-notice'
import { structuredAgentLabel } from '@/lib/agent-session/launch/structured-agent-session-launch-label'
import {
  StructuredAgentSessionCreateAbandonedError,
  StructuredAgentSessionCreateRefusalError
} from '@/lib/agent-session/launch/structured-agent-session-launch-errors'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { StructuredAgentSessionForkSource } from '../../../../shared/agent-session/structured-agent-session-create'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export type NativeChatForkRequest = {
  agent: TuiAgent
  worktreeId: string
  target: RuntimeClientTarget
  forkFrom: StructuredAgentSessionForkSource
  surfaceAddress: StructuredLaunchSurfaceAddress
}

/** Right after the source chat's tab, in that tab's group; read at the click, before the tab can move. */
export function nativeChatForkSurfaceAddress(
  worktreeId: string,
  sourceTabId: string
): StructuredLaunchSurfaceAddress {
  const group = useAppStore
    .getState()
    .groupsByWorktree[worktreeId]?.find((entry) => entry.tabOrder.includes(sourceTabId))
  if (!group) {
    return captureStructuredLaunchSurfaceAddress(worktreeId)
  }
  return {
    worktreeId,
    targetGroupId: group.id,
    precedingTabIds: group.tabOrder.slice(0, group.tabOrder.indexOf(sourceTabId) + 1)
  }
}

function executionHostIdFor(target: RuntimeClientTarget): ExecutionHostId {
  return target.kind === 'local'
    ? LOCAL_EXECUTION_HOST_ID
    : toRuntimeExecutionHostId(target.environmentId)
}

/** A side chat (`/btw`) opens beside its source; its question, if any, is the fork's first message. */
export type NativeChatSideChatRequest = { question?: string }

/** The chat a fork opened (or may have opened), and whether a side question went out with it. */
export type NativeChatForkOutcome = {
  chat?: { sessionId: string; executionHostId: ExecutionHostId }
  questionSent: boolean
}

/** Opens the fork in a new chat tab and says, once, why it didn't; the source chat is never touched.
 *  A side question stays the caller's until it goes out, so no composer gets a copy. */
export async function launchNativeChatFork(
  request: NativeChatForkRequest & { side?: NativeChatSideChatRequest }
): Promise<NativeChatForkOutcome> {
  const question = request.side?.question
  let launch: ReturnType<typeof startStructuredAgentLaunch> | undefined
  try {
    launch = startStructuredAgentLaunch(request.worktreeId, request.agent, {
      requestId: newAgentLaunchRequestId(),
      executionHostId: executionHostIdFor(request.target),
      forkFrom: request.forkFrom,
      // A side chat is selected once it sits beside its source.
      activate: request.side === undefined,
      surfaceAddress: request.surfaceAddress,
      ...(question ? { prompt: question, promptKeptByCaller: true as const } : {})
    })
    await launch.launchResult
  } catch (error) {
    const unconfirmed = launch?.isVisibilityUnknown() === true
    if (!(error instanceof StructuredAgentSessionCreateAbandonedError)) {
      reportNativeChatForkFailure(request.agent, error, unconfirmed)
    } else if (launch?.promptDeliveryResult) {
      await reportUnsentQuestion(request.agent, launch.promptDeliveryResult)
    }
    return { ...(unconfirmed && launch ? { chat: forkChat(launch) } : {}), questionSent: false }
  }
  // A question sent after create can still be refused once the chat exists.
  const questionSent = launch.promptDeliveryResult
    ? await reportUnsentQuestion(request.agent, launch.promptDeliveryResult)
    : true
  return { chat: forkChat(launch), questionSent }
}

function forkChat(launch: ReturnType<typeof startStructuredAgentLaunch>) {
  return { sessionId: launch.sessionId, executionHostId: launch.executionHostId }
}

async function reportUnsentQuestion(
  agent: TuiAgent,
  delivery: Promise<StructuredPromptDeliveryResult>
): Promise<boolean> {
  const outcome = await newAgentPromptOutcome({ delivery })
  if (outcome.failure) {
    toast.error(
      translate(
        'components.native-chat.sideChat.questionNotSent',
        "{{agent}} didn't get your question",
        {
          agent: structuredAgentLabel(agent)
        }
      ),
      {
        description: translate(
          'components.native-chat.sideChat.questionNotSentDetail',
          'Your question is still in this chat. Send /btw again to retry.'
        )
      }
    )
  }
  return outcome.delivered
}

function reportNativeChatForkFailure(agent: TuiAgent, error: unknown, unconfirmed: boolean): void {
  const agentLabel = structuredAgentLabel(agent)
  if (unconfirmed) {
    toast.error(
      translate('components.native-chat.fork.unconfirmed', "{{agent}} couldn't confirm the fork", {
        agent: agentLabel
      }),
      {
        description: translate(
          'components.native-chat.fork.unconfirmedDetail',
          'It may have opened anyway. Check Session History before forking again.'
        )
      }
    )
    return
  }
  toast.error(
    translate('components.native-chat.fork.failed', "{{agent}} couldn't fork this chat", {
      agent: agentLabel
    }),
    { description: forkFailureDetail(agentLabel, error) }
  )
}

function forkFailureDetail(agentLabel: string, error: unknown): string {
  const code = error instanceof StructuredAgentSessionCreateRefusalError ? error.code : undefined
  if (code === STRUCTURED_LAUNCH_FORK_UNSUPPORTED_REFUSAL) {
    return translate(
      'components.native-chat.fork.hostUnsupported',
      'This host runs an older Orca. Update Orca on the host, then try again.'
    )
  }
  if (code === 'structured_agent_session_host_permission') {
    return hostPermissionRefusedText(agentLabel, 'refused')
  }
  const causeText = structuredLaunchFailure(error)?.causeText
  if (causeText) {
    return causeText
  }
  // The host words its own fork refusals ("hasn't finished this response yet").
  if (code !== undefined && error instanceof Error && error.message && error.message !== code) {
    return error.message
  }
  return translate('components.native-chat.fork.failedDetail', 'Your chat is unchanged. Try again.')
}
