import { createBrowserUuid } from '@/lib/browser-uuid'
import { useLayoutEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import {
  terminalQueuedDrafts,
  type TerminalQueuedDrafts
} from './native-chat-terminal-queued-drafts'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'
import type { QueuedMessageInlineEditor } from './use-structured-agent-session-queued-edit'

export function useNativeChatTerminalQueueController({
  scope,
  queue,
  change,
  dispatch,
  canSteer,
  supportsSteering,
  working,
  reportError
}: {
  scope: string
  queue: TerminalQueuedDrafts | null
  change: (apply: (queue: TerminalQueuedDrafts) => void) => Promise<void>
  dispatch: (id: string, explicit: boolean) => Promise<void>
  canSteer: boolean
  supportsSteering: boolean
  working: boolean
  reportError: () => void
}): StructuredAgentSessionQueuedMessagesController {
  const [edit, setEdit] = useState<{
    scope: string
    id: string
    text: string
    baseText: string
    editId: string
  } | null>(null)
  const ownedEdit = useRef<{ scope: string; id: string; editId: string } | null>(null)
  const releaseEdit = (lease: { scope: string; id: string; editId: string }) =>
    terminalQueuedDrafts().change(lease.scope, (next) => {
      const message = next.messages.find((message) => message.id === lease.id)
      if (message?.state === 'editing' && message.editId === lease.editId) {
        message.state = 'waiting'
        delete message.editId
      }
    })
  const errorReporter = useRef(reportError)
  useLayoutEffect(() => {
    errorReporter.current = reportError
  })
  useLayoutEffect(() => {
    setEdit(null)
    return () => {
      const lease = ownedEdit.current
      ownedEdit.current = null
      if (lease) {
        void releaseEdit(lease).catch(() => errorReporter.current())
      }
    }
  }, [scope])
  const [saving, setSaving] = useState(false)
  const waiting =
    queue?.messages.filter(
      (message) => message.state === 'waiting' || message.state === 'editing'
    ) ?? []
  const editable = edit?.scope === scope ? edit : null
  const editor: QueuedMessageInlineEditor | undefined = editable
    ? {
        messageId: editable.id,
        text: editable.text,
        acquiring: false,
        saving,
        canSave: editable.text.trim().length > 0 && !saving,
        change: (text) => setEdit({ ...editable, text }),
        cancel: () => {
          void change((next) => {
            const message = next.messages.find((message) => message.id === editable.id)
            if (message?.state === 'editing' && message.editId === editable.editId) {
              message.state = 'waiting'
            }
          })
            .then(() => {
              if (ownedEdit.current?.editId === editable.editId) {
                ownedEdit.current = null
                setEdit(null)
              }
            })
            .catch(reportError)
        },
        save: () => {
          setSaving(true)
          void change((next) => {
            const message = next.messages.find((message) => message.id === editable.id)
            if (
              message?.state !== 'editing' ||
              message.text !== editable.baseText ||
              message.editId !== editable.editId
            ) {
              throw new Error('Queued draft changed while editing')
            }
            message.text = editable.text
            message.state = 'waiting'
          })
            .then(() => {
              if (ownedEdit.current?.editId === editable.editId) {
                ownedEdit.current = null
                setEdit(null)
              }
            })
            .catch(reportError)
            .finally(() => setSaving(false))
        }
      }
    : undefined
  const controller: StructuredAgentSessionQueuedMessagesController = {
    cards: (queue?.messages ?? []).map((message, index) => ({
      messageId: message.id,
      position: index + 1,
      text: message.text,
      images: message.imagePaths.map((path) => ({ type: 'image-ref' as const, path })),
      steerCapable: supportsSteering,
      ...(working && !supportsSteering ? { waitsForAgent: true as const } : {}),
      state: message.state === 'waiting' || message.state === 'editing' ? 'waiting' : 'returned',
      hold:
        message.state === 'editing'
          ? 'paused'
          : message.state === 'waiting'
            ? queue?.paused
              ? 'queue-paused'
              : working
                ? 'turn'
                : 'paused'
            : 'unconfirmed',
      ...(message.state !== 'waiting' && message.state !== 'editing'
        ? {
            waitsForAgent: true as const,
            returnedReason: translate(
              'components.native-chat.terminalQueue.deliveryUnknown',
              'Delivery is unconfirmed. Check the conversation before deleting this draft; it will not be sent again automatically.'
            )
          }
        : {})
    })),
    queueCapable: true,
    clearCapable: !queue?.messages.some((message) => message.state === 'sending'),
    queuePending: null,
    pause: queue?.paused ? { reason: 'client-held' } : null,
    pending: (id) =>
      queue?.messages.find((message) => message.id === id)?.state === 'sending' ? 'send' : null,
    resume: async () => {
      try {
        await change((next) => {
          next.paused = false
        })
        return true
      } catch {
        reportError()
        return false
      }
    },
    clear: async () => {
      try {
        await change((next) => {
          next.messages = next.messages.filter((message) => message.state === 'sending')
        })
        return true
      } catch {
        reportError()
        return false
      }
    },
    steer: async (id) => {
      if (!editable && canSteer) {
        await dispatch(id, true)
      }
    },
    remove: async (id) => {
      try {
        await change((next) => {
          next.messages = next.messages.filter(
            (message) => message.id !== id || message.state === 'sending'
          )
        })
      } catch {
        reportError()
      }
    },
    editCapable: !queue?.messages.some(
      (message) => message.state === 'sending' || message.state === 'unknown'
    ),
    editor,
    edit: async (id) => {
      const message = waiting.find((message) => message.id === id)
      if (message) {
        if (ownedEdit.current) {
          return
        }
        const editId = createBrowserUuid()
        const lease = { scope, id, editId }
        ownedEdit.current = lease
        try {
          await change((next) => {
            const selected = next.messages.find((message) => message.id === id)
            if (!selected || (selected.state !== 'waiting' && selected.state !== 'editing')) {
              throw new Error('Queued draft is sending')
            }
            selected.state = 'editing'
            selected.editId = editId
          })
          if (ownedEdit.current !== lease) {
            await releaseEdit(lease)
            return
          }
          setEdit({ scope, id, text: message.text, baseText: message.text, editId })
        } catch {
          if (ownedEdit.current === lease) {
            ownedEdit.current = null
          }
          reportError()
        }
      }
    },
    steerNewest: () => {
      const newest = waiting.at(-1)
      if (!newest || editable || !canSteer) {
        return false
      }
      void dispatch(newest.id, true)
      return true
    }
  }
  return controller
}
