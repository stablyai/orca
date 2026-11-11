import { agentSessionForkSourceFailureWords } from '../../../../../../shared/agent-session/failures/agent-session-failure-copy'
import { sayAgentSessionFailureTranslated } from '../notices/agent-session-failure-words-text'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

import { createNonSecureContextUuid } from '../../../../../../shared/non-secure-context-uuid'
import { startStructuredAgentLaunch } from '@/lib/agent-session/launch/structured-agent-session-launch'
import { captureStructuredLaunchSurfaceAddress } from '@/lib/agent-session/launch/structured-agent-session-launch-surface'
import type { StructuredLaunchSurfaceAddress } from '@/lib/agent-session/launch/structured-agent-session-launch-record'
import { STRUCTURED_LAUNCH_FORK_UNSUPPORTED_REFUSAL } from '@/lib/agent-session/launch/structured-agent-session-launch-fork-support'
import { structuredLaunchFailure } from '@/lib/agent-session/launch/structured-agent-session-launch-failure'
import type { StructuredPromptDeliveryResult } from '@/lib/agent-session/launch/structured-agent-session-launch-callers'
import { hostPermissionRefusedText } from '@/lib/agent-session/launch/structured-agent-session-launch-permission-notice'
import { structuredAgentLabel } from '@/lib/agent-session/launch/structured-agent-session-launch-label'
import {
  StructuredAgentSessionCreateAbandonedError,
  StructuredAgentSessionCreateRefusalError
} from '@/lib/agent-session/launch/structured-agent-session-launch-errors'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { StructuredAgentSessionForkSource } from '../../../../../../shared/agent-session/structured-agent-session-create'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'

export type NativeChatForkRequest = {
  agent: TuiAgent
  worktreeId: string
  target: RuntimeClientTarget
  forkFrom: StructuredAgentSessionForkSource
  /** Client-only admission requirement; reacquired from the child after reload. */
  forkRequiresInheritedOriginal?: boolean
  surfaceAddress: StructuredLaunchSurfaceAddress
  /** Text left unsent in the fork's composer, as when forking from one of your own messages. */
  draft?: string
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

/** Whether a side question reached the fork; `unconfirmed` may have. */
export type NativeChatSideQuestionDelivery = 'sent' | 'failed' | 'unconfirmed'

/** The chat a fork opened (or may have opened), and, for a side question, whether it went out. */
export type NativeChatForkOutcome = {
  chat?: { sessionId: string; executionHostId: ExecutionHostId }
  question?: NativeChatSideQuestionDelivery
}

/** Opens the fork in a new chat tab and says, once, why it didn't; the source chat is never touched.
 *  A side question stays the caller's until it goes out, so no composer gets a copy. */
export async function launchNativeChatFork(
  request: NativeChatForkRequest & { side?: NativeChatSideChatRequest }
): Promise<NativeChatForkOutcome> {
  const question = request.side?.question
  let launch: ReturnType<typeof startStructuredAgentLaunch>
  try {
    launch = startStructuredAgentLaunch(request.worktreeId, request.agent, {
      requestId: createNonSecureContextUuid(),
      executionHostId: executionHostIdFor(request.target),
      forkFrom: request.forkFrom,
      forkRequiresInheritedOriginal: request.forkRequiresInheritedOriginal,
      // A side chat is selected once it sits beside its source.
      activate: request.side === undefined,
      surfaceAddress: request.surfaceAddress,
      ...(question
        ? { prompt: question, promptKeptByCaller: true as const }
        : request.draft
          ? { prompt: request.draft, promptDelivery: 'draft' as const }
          : {})
    })
  } catch (error) {
    reportNativeChatForkFailure(request.agent, error, false)
    return question ? { question: 'failed' } : {}
  }
  const failure = await launch.launchResult.then(
    () => null,
    (error: unknown) => ({ error })
  )
  // A question sent after create can still be refused once the chat exists.
  const delivery = launch.promptDeliveryResult
    ? await sideQuestionDelivery(launch.promptDeliveryResult)
    : undefined
  const chat = forkChat(launch)
  if (delivery === 'unconfirmed') {
    reportSideQuestion(request.agent, delivery)
    return { chat, question: delivery }
  }
  if (failure && !(failure.error instanceof StructuredAgentSessionCreateAbandonedError)) {
    const unconfirmed = launch.isVisibilityUnknown()
    reportNativeChatForkFailure(request.agent, failure.error, unconfirmed)
    return { ...(unconfirmed ? { chat } : {}), ...(delivery ? { question: delivery } : {}) }
  }
  // The fork may have said so too, but it stays in the background.
  if (delivery === 'failed') {
    reportSideQuestion(request.agent, delivery)
  }
  return { ...(failure ? {} : { chat }), ...(delivery ? { question: delivery } : {}) }
}

function forkChat(launch: ReturnType<typeof startStructuredAgentLaunch>) {
  return { sessionId: launch.sessionId, executionHostId: launch.executionHostId }
}

function sideQuestionDelivery(
  result: Promise<StructuredPromptDeliveryResult>
): Promise<NativeChatSideQuestionDelivery> {
  return result.then(
    (outcome) =>
      outcome.delivered || outcome.inComposer || outcome.recipientOwned
        ? 'sent'
        : outcome.unconfirmed
          ? 'unconfirmed'
          : 'failed',
    () => 'failed'
  )
}

/** The source keeps the question either way; the fork it may be in waits in the background. */
function reportSideQuestion(agent: TuiAgent, delivery: 'failed' | 'unconfirmed'): void {
  const values = { agent: structuredAgentLabel(agent) }
  if (delivery === 'unconfirmed') {
    toast.error(
      translate(
        'components.native-chat.sideChat.questionUnconfirmed',
        "{{agent}} couldn't confirm the side chat got your question",
        values
      ),
      {
        description: translate(
          'components.native-chat.sideChat.questionUnconfirmedDetail',
          'Check the side chat before asking again. Your question is still in this chat.'
        )
      }
    )
    return
  }
  toast.error(
    translate(
      'components.native-chat.sideChat.questionNotSent',
      "{{agent}} didn't get your question",
      values
    ),
    {
      description: translate(
        'components.native-chat.sideChat.questionNotSentDetail',
        'Your question is still in this chat. Send /btw again to retry.'
      )
    }
  )
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
  const sourceFailure =
    error instanceof StructuredAgentSessionCreateRefusalError
      ? agentSessionForkSourceFailureWords(
          error.message,
          agentLabel,
          sayAgentSessionFailureTranslated
        )
      : null
  if (sourceFailure) {
    return sourceFailure
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
