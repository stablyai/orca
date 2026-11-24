// A bot chat's Slack thread, read once per chat from the bot home's links, for its composer item and
// its message rows; rows read their own post from it, so no row subscribes to anything.
import { createContext, useCallback, useContext, useMemo } from 'react'
import {
  useConfirmationDialog,
  type ConfirmationDialogContextValue
} from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { callBotRpc, isSameBot } from '@/lib/bot-hosts'
import { readBots } from '@/lib/bot-catalog'
import type { Bot } from '../../../../../shared/bot-types'
import type { ExternalConversationLink } from '../../../../../shared/connectors/external-conversation-link'
import type { SlackMirrorStatus } from '../../../../../shared/connectors/connector-slack-mirror-contract'
import { slackMirrorAvailable } from '../../../../../shared/connectors/slack-mirror-state'
import { selectFolderWorkspaceOnHost } from '../../../store/folder-workspaces/folder-workspace-record-index'

export type NativeChatSlackMirror = {
  /** The bot as the catalog has it now; null once it is gone. */
  bot: () => Bot | null
  botName: string
  sessionId: string
  link: ExternalConversationLink
  /** Some message of this chat is in the thread. */
  anyPosted: boolean
  setOn: (on: boolean) => Promise<boolean>
  post: (itemId: string, action: 'retry' | 'dismiss' | 'delete') => Promise<boolean>
  status: () => Promise<SlackMirrorStatus | null>
}

export const NativeChatSlackMirrorContext = createContext<NativeChatSlackMirror | null>(null)

export function useNativeChatSlackMirrorContext(): NativeChatSlackMirror | null {
  return useContext(NativeChatSlackMirrorContext)
}

/** The chat's Slack thread link, when it is a bot's and can post back; null otherwise. */
export function useNativeChatSlackMirror(
  bot: Bot | null,
  sessionId: string
): NativeChatSlackMirror | null {
  const link = useAppStore((state) => {
    if (!bot) {
      return null
    }
    const workspace = selectFolderWorkspaceOnHost(state, bot.folderWorkspaceId, bot.hostId)
    return (
      workspace?.externalConversations?.find(
        (entry) => entry.sessionId === sessionId && slackMirrorAvailable(entry)
      ) ?? null
    )
  })
  // Keyed on what the chat shows, as plain values: a re-read bot or a rewritten workspace record
  // with the same link facts must not re-render every row of the chat.
  const linkJson = link ? JSON.stringify(link) : null
  const botId = bot?.id ?? null
  const hostId = bot?.hostId ?? null
  const botName = bot?.name ?? ''
  return useMemo(() => {
    if (!linkJson || !botId || !hostId) {
      return null
    }
    const kept: ExternalConversationLink = JSON.parse(linkJson)
    const ref = { id: botId, hostId }
    const call = <T>(method: string, params: unknown) => callBotRpc<T>(ref, method, params)
    const ok = (answer: Promise<{ ok: boolean }>) =>
      answer.then((value) => value.ok).catch(() => false)
    return {
      bot: () => readBots().find((entry) => isSameBot(entry, ref)) ?? null,
      botName,
      sessionId,
      link: kept,
      anyPosted: Object.values(kept.mirrorPosts ?? {}).some((post) => post.state === 'posted'),
      setOn: (on) => ok(call('connector.slackMirror.set', { sessionId, on })),
      post: (itemId, action) =>
        ok(call('connector.slackMirror.post', { sessionId, itemId, action })),
      status: () =>
        call<{ status: SlackMirrorStatus | null }>('connector.slackMirror.status', { sessionId })
          .then((answer) => answer.status)
          .catch(() => null)
    }
  }, [linkJson, botId, hostId, botName, sessionId])
}

/** The confirm a rewind asks with: in a chat that posted to Slack it says those posts stay. */
export function useNativeChatRewindConfirm(): ConfirmationDialogContextValue {
  const confirm = useConfirmationDialog()
  const anyPosted = useNativeChatSlackMirrorContext()?.anyPosted === true
  return useCallback(
    (options) =>
      confirm(
        anyPosted
          ? {
              ...options,
              details: translate(
                'components.native-chat.slackMirror.rewindStays',
                'Messages already in Slack stay there.'
              )
            }
          : options
      ),
    [confirm, anyPosted]
  )
}
