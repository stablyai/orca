import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { createNonSecureContextUuid } from '../../../../../../../shared/identifiers/non-secure-context-uuid'
import { startStructuredAgentLaunch } from '@/lib/agent-session/launch/structured-agent-session-launch'
import { findStructuredLaunchTab } from '@/lib/agent-session/launch/structured-agent-session-launch-surface'
import { structuredLaunchFailure } from '@/lib/agent-session/launch/structured-agent-session-launch-failure'
import { structuredAgentLabel } from '@/lib/agent-session/launch/structured-agent-session-launch-label'
import { StructuredAgentSessionCreateAbandonedError } from '@/lib/agent-session/launch/structured-agent-session-launch-errors'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { executionHostIdForStructuredTarget } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { nativeChatForkSurfaceAddress } from '../../../messages/actions/native-chat-fork-launch'
import { openBotChat, updateBot } from '@/lib/bot-catalog'
import { botLaunchFromChoices } from '../../../../../../../shared/bots/bot-launch'
import { isBotAgent, type Bot } from '../../../../../../../shared/bot-types'
import type { TuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

export type NativeChatCrossVendorSwitchRequest = {
  worktreeId: string
  target: RuntimeClientTarget
  /** The chat being continued, and the tab it is shown in. */
  sourceTabId: string
  sourceSessionId: string
  sourceAgent: string
  agent: TuiAgent
  model?: string
  effort?: string
}

export type NativeChatCrossVendorSwitchOutcome =
  | { ok: true; sessionId: string }
  | { ok: false; error: string }

function errorText(error: unknown): string {
  const cause = structuredLaunchFailure(error)?.causeText
  if (cause) {
    return cause
  }
  return error instanceof Error && error.message ? error.message : String(error)
}

function closeTabOf(worktreeId: string, sessionId: string, target: RuntimeClientTarget): void {
  const tab = findStructuredLaunchTab({
    worktreeId,
    sessionId,
    executionHostId: executionHostIdForStructuredTarget(target)
  })
  if (tab) {
    useAppStore.getState().closeUnifiedTab(tab.id, { preserveWorktreeSelection: true })
  }
}

/** Continues this chat with another vendor's agent in the tab's place: a new chat of that agent opens
 *  right after this tab, receives the conversation, and replaces the tab. On failure the original
 *  tab stays, untouched, so the person keeps talking to the agent they had. */
export async function switchNativeChatToVendor(
  request: NativeChatCrossVendorSwitchRequest
): Promise<NativeChatCrossVendorSwitchOutcome> {
  const agentLabel = structuredAgentLabel(request.agent)
  const launchOptions: Record<string, string> = {
    ...(request.model ? { model: request.model } : {}),
    ...(request.effort ? { effort: request.effort } : {})
  }
  let launch: ReturnType<typeof startStructuredAgentLaunch>
  try {
    launch = startStructuredAgentLaunch(request.worktreeId, request.agent, {
      requestId: createNonSecureContextUuid(),
      executionHostId: executionHostIdForStructuredTarget(request.target),
      activate: true,
      surfaceAddress: nativeChatForkSurfaceAddress(request.worktreeId, request.sourceTabId),
      ...(Object.keys(launchOptions).length > 0 ? { launchOptions } : {})
    })
  } catch (error) {
    return reportFailure(agentLabel, errorText(error))
  }
  try {
    await launch.launchResult
  } catch (error) {
    if (!launch.isVisibilityUnknown()) {
      closeTabOf(request.worktreeId, launch.sessionId, request.target)
    }
    useAppStore.getState().activateTab(request.sourceTabId, { worktreeId: request.worktreeId })
    return reportFailure(
      agentLabel,
      error instanceof StructuredAgentSessionCreateAbandonedError
        ? translate('components.native-chat.crossVendor.cancelled', 'The switch was cancelled.')
        : errorText(error)
    )
  }
  try {
    await callStructuredAgentSession(request.target, 'agentSession.crossVendorHandoff', {
      sessionId: launch.sessionId,
      sourceSessionId: request.sourceSessionId
    })
  } catch (error) {
    // A chat without the conversation would answer out of context: drop it and keep the original.
    closeTabOf(request.worktreeId, launch.sessionId, request.target)
    useAppStore.getState().activateTab(request.sourceTabId, { worktreeId: request.worktreeId })
    return reportFailure(agentLabel, errorText(error))
  }
  const state = useAppStore.getState()
  const source = state.getTab(request.sourceTabId)
  const created = findStructuredLaunchTab({
    worktreeId: request.worktreeId,
    sessionId: launch.sessionId,
    executionHostId: executionHostIdForStructuredTarget(request.target)
  })
  if (created && source?.customLabel) {
    state.setTabCustomLabel(created.id, source.customLabel, { recordInteraction: false })
  }
  if (created) {
    state.activateTab(created.id, { worktreeId: request.worktreeId })
  }
  // The earlier chat stays in Session History; its tab gives way to the continuation.
  state.closeUnifiedTab(request.sourceTabId, { preserveWorktreeSelection: true })
  return { ok: true, sessionId: launch.sessionId }
}

/** A bot's Home Chat: the bot moves to `agent`, its Home starts fresh there, and the earlier Home
 *  conversation is handed to it, so the Home tab carries on with the new agent. */
export async function switchBotHomeChatToVendor(
  request: Omit<NativeChatCrossVendorSwitchRequest, 'sourceTabId' | 'worktreeId'> & { bot: Bot }
): Promise<NativeChatCrossVendorSwitchOutcome> {
  const agentLabel = structuredAgentLabel(request.agent)
  if (!isBotAgent(request.agent)) {
    return reportFailure(
      agentLabel,
      translate(
        'components.native-chat.crossVendor.botUnsupported',
        "Bots can't run on this agent yet."
      )
    )
  }
  const launch = botLaunchFromChoices({
    ...(request.model ? { model: request.model } : {}),
    ...(request.effort ? { options: { effort: request.effort } } : {})
  })
  const previous = { agent: request.bot.agent, launch: request.bot.launch ?? null }
  let sessionId: string
  try {
    const updated = await updateBot(request.bot, { agent: request.agent, launch: launch ?? null })
    sessionId = await openBotChat(updated)
  } catch (error) {
    await updateBot(request.bot, previous).catch(() => undefined)
    return reportFailure(agentLabel, errorText(error))
  }
  if (sessionId === request.sourceSessionId) {
    return reportFailure(
      agentLabel,
      translate('components.native-chat.crossVendor.botHomeKept', 'The bot kept its current chat.')
    )
  }
  try {
    await callStructuredAgentSession(request.target, 'agentSession.crossVendorHandoff', {
      sessionId,
      sourceSessionId: request.sourceSessionId
    })
  } catch (error) {
    // The new Home runs without the conversation; say so where the person is now looking.
    return reportFailure(agentLabel, errorText(error))
  }
  return { ok: true, sessionId }
}

function reportFailure(agentLabel: string, detail: string): NativeChatCrossVendorSwitchOutcome {
  const title = translate(
    'components.native-chat.crossVendor.failed',
    "Couldn't switch this chat to {{agent}}",
    { agent: agentLabel }
  )
  toast.error(title, { description: detail })
  return { ok: false, error: `${title}: ${detail}` }
}
