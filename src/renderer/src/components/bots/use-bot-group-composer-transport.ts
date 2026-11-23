// The group composer's structured transport: routes sends and attachment uploads to the room's host
// using a stable member session id, and falls back to text-only on older paired servers.
import { useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { botTarget, callBotRpc } from '@/lib/bot-hosts'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { BOTS_GROUP_ATTACHMENTS_RUNTIME_CAPABILITY } from '../../../../shared/bot-runtime-capabilities'
import type { BotGroup, BotGroupMessage } from '../../../../shared/bots/bot-group'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import type { NativeChatStructuredComposerTransport } from '../native-chat/composer/submit/native-chat-structured-composer-transport'
import type { BotGroupSession } from './BotGroupSessionReader'
import { useBotHostLabel } from './use-bot-host-label'

const NO_OPTIONS: NativeChatStructuredComposerTransport['optionsSurface'] = {
  getSnapshot: () => [],
  subscribe: () => () => {},
  setOption: async () => ({ snapshot: [] }),
  invokeAction: async () => ({ snapshot: [] })
}

async function sendBotGroupPost({
  group,
  threadId,
  text,
  images,
  setSending,
  onSent,
  onError
}: {
  group: BotGroup
  threadId: string | undefined
  text: string
  images: readonly string[]
  setSending: (sending: boolean) => void
  onSent: (message: BotGroupMessage) => void
  onError: (error: string | null) => void
}): Promise<boolean> {
  setSending(true)
  try {
    const { message } = await callBotRpc<{ message: BotGroupMessage }>(group, 'bots.groups.send', {
      groupId: group.id,
      threadId,
      revision: group.revision,
      messageId: createBrowserUuid(),
      text,
      ...(images.length > 0 ? { images } : {})
    })
    onSent(message)
    onError(null)
    return true
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error))
    return false
  } finally {
    setSending(false)
  }
}

export function useBotGroupComposerTransport({
  roomId,
  threadId,
  group,
  chosen,
  onSent,
  onError
}: {
  roomId: string
  threadId: string | undefined
  group: BotGroup | undefined
  chosen: BotGroupSession | undefined
  onSent: (message: BotGroupMessage) => void
  onError: (error: string | null) => void
}): NativeChatStructuredComposerTransport {
  const t = useTranslate()
  const [sending, setSending] = useState(false)
  const target = group ? botTarget(group) : null
  const runtimeEnvironmentId = target ? runtimeTargetEnvironmentId(target) : null
  const hostLabel = useBotHostLabel(group?.hostId ?? 'local')
  const remoteCapability = useStructuredAgentSessionHostCapabilityState(
    runtimeEnvironmentId !== null ? target : null,
    BOTS_GROUP_ATTACHMENTS_RUNTIME_CAPABILITY
  )
  // An unknown paired-host capability is treated as unsupported so older servers never see `images`.
  const hostTakesAttachments = runtimeEnvironmentId === null || remoteCapability === 'supported'
  const hostTooOldNotice = t(
    'bots.groups.attachmentsHostTooOld',
    '{{host}} needs an update to attach files in group chats.',
    { host: hostLabel ?? t('bots.items.comment.thisServer', 'This server') }
  )
  // Pick a stable member session so typing `@Bot` never changes the composer target mid-upload.
  const uploadSessionId = group?.members[0]?.sessionId ?? null
  const acceptsImages = Boolean(group && hostTakesAttachments && uploadSessionId)

  return {
    runtime: runtimeEnvironmentId ? 'remote' : 'local',
    sessionId: uploadSessionId ?? `bot-group:${roomId}`,
    runtimeEnvironmentId,
    ...(runtimeEnvironmentId !== null && !hostTakesAttachments
      ? { sessionPending: true, sessionPendingNotice: hostTooOldNotice }
      : {}),
    capturePresentation: chosen?.capturePresentation ?? (() => () => true),
    acceptsImages,
    worktreeId: group && folderWorkspaceKey(group.folderWorkspaceId),
    optionsSurface: chosen?.optionSurface ?? NO_OPTIONS,
    optionSnapshot: chosen?.optionSnapshot ?? [],
    sendOut: sending,
    send: async (text, attachments) => {
      if (!group || sending) {
        return false
      }
      if (attachments.length > 0 && !hostTakesAttachments) {
        onError(hostTooOldNotice)
        return false
      }
      return sendBotGroupPost({
        group,
        threadId,
        text,
        images: attachments.map(({ path }) => path),
        setSending,
        onSent,
        onError
      })
    },
    dispatchCommand: async (text) =>
      text.startsWith('/')
        ? {
            handled: true,
            accepted: false,
            error: t(
              'bots.groups.useEachBotSNativeSessionForCommands',
              'Use each bot’s native session for commands.'
            )
          }
        : { handled: false, accepted: false, error: null },
    onError
  }
}
