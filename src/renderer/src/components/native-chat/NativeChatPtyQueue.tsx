import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import type {
  NativeChatQueuedMessage,
  NativeChatQueueSnapshot
} from '../../../../shared/native-chat-queue'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { QueuedMessageStack } from './QueuedMessageStack'
import { sendNativeChatMessage, sendNativeChatTypedCommand } from './native-chat-runtime-send'
import { sendNativeChatMessageWithImageAttachments } from './native-chat-runtime-image-send'
import { isSlashCommandDraft } from '../../../../shared/native-chat-slash-commands'
import type { NativeChatImageLoadContext } from './NativeChatImageAttachments'

export type NativeChatPtyQueueHandle = {
  enqueue: (
    text: string,
    imagePaths: readonly string[],
    kind: NativeChatQueuedMessage['kind']
  ) => Promise<void>
  edit: (
    messageId: string,
    text: string,
    imagePaths: readonly string[],
    kind: NativeChatQueuedMessage['kind']
  ) => Promise<void>
  pause: () => Promise<void>
}

type Props = {
  paneKey: string
  terminalTabId: string
  targetPtyId: string | null
  agent: AgentType
  isWorking: boolean
  imageLoadContext?: NativeChatImageLoadContext
  onDelivered: (text: string, imagePaths: string[]) => string | undefined
  onDeliveryCanceled: (pendingId: string) => void
  onCommand: (command: string) => void
  onQueueStateChange: (hasItems: boolean) => void
  editingMessageId: string | null
  onEditMessage: (message: NativeChatQueuedMessage) => void
}

export const NativeChatPtyQueue = forwardRef<NativeChatPtyQueueHandle, Props>(
  function NativeChatPtyQueue(
    {
      paneKey,
      terminalTabId,
      targetPtyId,
      agent,
      isWorking,
      imageLoadContext,
      onDelivered,
      onDeliveryCanceled,
      onCommand,
      onQueueStateChange,
      editingMessageId,
      onEditMessage
    },
    ref
  ): React.JSX.Element | null {
    const [snapshot, setSnapshot] = useState<NativeChatQueueSnapshot | null>(null)
    const [error, setError] = useState<string | null>(null)
    const snapshotRef = useRef(snapshot)
    const idleArmed = useRef(true)
    snapshotRef.current = snapshot
    useEffect(
      () => onQueueStateChange(Boolean(snapshot?.items.length)),
      [onQueueStateChange, snapshot?.items.length]
    )

    const read = useCallback(async (): Promise<NativeChatQueueSnapshot> => {
      const next = await callRuntimeRpc<NativeChatQueueSnapshot>(
        { kind: 'local' },
        'nativeChat.queue.read',
        { paneKey }
      )
      snapshotRef.current = next
      setSnapshot(next)
      return next
    }, [paneKey])

    useEffect(() => {
      setSnapshot(null)
      setError(null)
      idleArmed.current = true
      void read().catch((cause) => setError(String(cause)))
    }, [read])

    const mutate = useCallback(
      async (method: string, params: Record<string, unknown> = {}) => {
        const current = snapshotRef.current ?? (await read())
        try {
          const next = await callRuntimeRpc<NativeChatQueueSnapshot>({ kind: 'local' }, method, {
            paneKey,
            expectedRevision: current.revision,
            ...params
          })
          snapshotRef.current = next
          setSnapshot(next)
          setError(null)
          return next
        } catch (error) {
          await read().catch(() => undefined)
          throw error
        }
      },
      [paneKey, read]
    )

    useImperativeHandle(
      ref,
      () => ({
        enqueue: async (text, imagePaths, kind) => {
          await mutate('nativeChat.queue.enqueue', { text, imagePaths, kind })
        },
        edit: async (messageId, text, imagePaths, kind) => {
          idleArmed.current = true
          await mutate('nativeChat.queue.edit', { messageId, text, imagePaths, kind })
        },
        pause: async () => {
          idleArmed.current = false
          if (snapshotRef.current?.items.length) {
            await mutate('nativeChat.queue.pause')
          }
        }
      }),
      [mutate]
    )

    useEffect(() => {
      if (isWorking) {
        idleArmed.current = true
        return
      }
      const current = snapshotRef.current
      if (
        !idleArmed.current ||
        !targetPtyId ||
        current?.paused ||
        !current?.items.some((item) => item.state === 'pending')
      ) {
        return
      }
      idleArmed.current = false
      void (async () => {
        const claimed = await mutate('nativeChat.queue.claim')
        const message = claimed.items.find((item) => item.state === 'submitting')
        if (!message) {
          return
        }
        let pendingId: string | undefined
        try {
          const settings = getSettingsForAgentTabRuntimeOwner(terminalTabId)
          const handle =
            message.kind === 'command' && agent === 'codex' && isSlashCommandDraft(message.text)
              ? sendNativeChatTypedCommand(settings, targetPtyId, message.text)
              : message.imagePaths.length
                ? sendNativeChatMessageWithImageAttachments(
                    settings,
                    targetPtyId,
                    message.text,
                    message.imagePaths
                  )
                : sendNativeChatMessage(settings, targetPtyId, message.text)
          pendingId =
            message.kind === 'chat' ? onDelivered(message.text, message.imagePaths) : undefined
          await handle.settled
          if (handle.submitted?.() === false) {
            throw new Error('conversation_send_uncertain')
          }
          await mutate('nativeChat.queue.accept', { messageId: message.id })
          if (message.kind === 'command') {
            onCommand(message.text.trim())
          }
        } catch (cause) {
          if (pendingId) {
            onDeliveryCanceled(pendingId)
          }
          const messageText = cause instanceof Error ? cause.message : String(cause)
          try {
            await mutate('nativeChat.queue.reject', {
              messageId: message.id,
              uncertain: messageText === 'conversation_send_uncertain',
              error: messageText
            })
          } catch {
            await read().catch(() => undefined)
          }
          setError(messageText)
        }
      })().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
    }, [
      agent,
      isWorking,
      mutate,
      onCommand,
      onDeliveryCanceled,
      onDelivered,
      read,
      snapshot?.revision,
      targetPtyId,
      terminalTabId
    ])

    if (!snapshot?.items.length) {
      return null
    }
    const run = (method: string, params?: Record<string, unknown>): void => {
      idleArmed.current = true
      void mutate(method, params).catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause))
      )
    }

    return (
      <div className="mx-auto w-full max-w-4xl px-4 pt-2">
        <QueuedMessageStack
          items={snapshot.items}
          editingMessageId={editingMessageId}
          disabled={Boolean(editingMessageId)}
          canSteer={false}
          imageLoadContext={imageLoadContext}
          onEditInComposer={(item) => {
            const message = snapshot.items.find((candidate) => candidate.id === item.id)
            if (!message) {
              return
            }
            void mutate('nativeChat.queue.beginEdit', { messageId: item.id }).then(
              () => onEditMessage(message),
              (cause) => setError(cause instanceof Error ? cause.message : String(cause))
            )
          }}
          onRemove={(messageId) => run('nativeChat.queue.remove', { messageId })}
          onRetry={(messageId) => {
            run('nativeChat.queue.retry', { messageId })
          }}
          onReorder={(messageIds) => run('nativeChat.queue.reorder', { messageIds })}
          interrupted={snapshot.paused === 'interrupted'}
          onResume={() => run('nativeChat.queue.resume')}
        />
        {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
      </div>
    )
  }
)
