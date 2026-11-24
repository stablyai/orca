// A teammate's messages held in Orca Cloud for a shared agent's host that was away: drawn in their
// chat as sent messages until the host's journal has them, each with the cloud's word on it.
import { useMemo } from 'react'
import { toast } from 'sonner'
import { agentJournalSubmissionKey } from '../../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { SharedBotHostView } from '../../../../../../../shared/bots/shared-bot-hosts'
import type { StructuredAgentSessionOptimisticMessage } from '../../../../../../../shared/agent-session/view/structured-agent-session-message-projection'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useTranslate } from '@/i18n/use-translate'
import {
  sharedBotHostFor,
  useSharedBotHosts
} from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import type { NativeChatDeliveryNotice } from '../../../messages/rows/NativeChatMessageRow'

export type SharedBotHeldMessages = {
  /** Drawn after the chat's rows; the host's own row replaces each once it records it. */
  messages: readonly StructuredAgentSessionOptimisticMessage[]
  notices: ReadonlyMap<string, NativeChatDeliveryNotice>
}

const NONE: SharedBotHeldMessages = { messages: [], notices: new Map() }

export type SharedBotHeldWords = {
  waiting: (owner: string) => string
  notSent: string
}

/** One chat's held messages on its shared host: Waiting, then nothing once delivered, or Not sent. */
export function sharedBotHeldMessages(
  host: SharedBotHostView | null,
  sessionId: string,
  words: SharedBotHeldWords,
  sendAgain: (clientMessageId: string) => void
): SharedBotHeldMessages {
  const held = host?.held.filter((message) => message.sessionId === sessionId) ?? []
  if (!host || held.length === 0) {
    return NONE
  }
  const notices = new Map<string, NativeChatDeliveryNotice>()
  for (const message of held) {
    const id = agentJournalSubmissionKey(message.clientMessageId)
    if (message.state === 'waiting') {
      notices.set(id, { text: words.waiting(host.ownerName), waiting: true })
    } else if (message.state === 'not_sent') {
      notices.set(id, {
        text: words.notSent,
        onSendAgain: () => sendAgain(message.clientMessageId)
      })
    }
  }
  return {
    messages: held.map((message) => ({
      clientMessageId: message.clientMessageId,
      body: {
        kind: 'message',
        role: 'user',
        // Its files are named under its words, so a message of files alone still draws a row.
        blocks: [
          {
            type: 'text',
            text: [message.text, ...message.attachments].filter(Boolean).join('\n\n')
          }
        ]
      },
      queuedAt: message.sentAt
    })),
    notices
  }
}

/** The held messages of the chat `sessionId` on `target`, when it is a shared agent's host. */
export function useSharedBotHeldMessages(
  target: RuntimeClientTarget,
  sessionId: string
): SharedBotHeldMessages {
  const t = useTranslate()
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  // Read for its changes; the lookup below is the same catalog's.
  const hosts = useSharedBotHosts()
  return useMemo(() => {
    const host =
      environmentId !== null && hosts.length > 0
        ? sharedBotHostFor({ kind: 'environment', environmentId })
        : null
    return sharedBotHeldMessages(
      host,
      sessionId,
      {
        waiting: (owner) =>
          t('components.native-chat.sharedHeld.waiting', 'Waiting for {{owner}}’s computer', {
            owner
          }),
        notSent: t('components.native-chat.sharedHeld.notSent', 'Not sent')
      },
      (clientMessageId) => {
        if (!host) {
          return
        }
        void window.api.sharedBotHosts
          .sendAgain({ environmentId: host.environmentId, clientMessageId })
          .then(
            (held) => {
              if (!held) {
                toast.error(
                  t('components.native-chat.sharedHeld.notHeld', 'Couldn’t send it again')
                )
              }
            },
            () =>
              toast.error(t('components.native-chat.sharedHeld.notHeld', 'Couldn’t send it again'))
          )
      }
    )
  }, [environmentId, hosts, sessionId, t])
}
