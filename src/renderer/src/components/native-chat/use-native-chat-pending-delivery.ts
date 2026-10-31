import type { NativeChatComposerHandle } from './native-chat-composer-types'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { returnMessageToComposer } from './structured-agent-session-message-hand-back'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import type { AgentType, NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  pendingSendsAsMessages,
  prunePendingSends,
  releaseEmptyTranscriptClaims,
  type NativeChatPendingSend
} from '../../../../shared/native-chat-pending-sends'
import {
  appendPendingSendCache,
  nextNativeChatPendingSendId,
  readPendingSendCache,
  writePendingSendCache
} from './native-chat-pending'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'
import type { ReadState } from './native-chat-live-session-contract'

/** Wait for transcript evidence after lost write acknowledgment; mobile uses the same hold. */
export const NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS = 20_000

const NO_NOTICES: ReadonlyMap<string, NativeChatDeliveryNotice> = new Map()

/** Keep optimistic PTY echoes and definite transport outcomes until reconciliation. */
export function useNativeChatPendingDelivery(args: {
  paneKey: string
  agent: AgentType
  composerRef?: { current: NativeChatComposerHandle | null }
  /** `readPhase` 'ready' with a `sessionId` means an empty `messages` was a real read. */
  session: {
    messages: NativeChatMessage[]
    readPhase?: ReadState['phase']
    sessionId?: string | null
  }
}) {
  const languageRevision = useUiLanguageRevision()
  const { paneKey, agent, composerRef } = args
  const { messages } = args.session
  const sessionId = args.session.sessionId ?? null
  // Without a sessionId, ready is an unread placeholder.
  const readEmptySessionId =
    args.session.readPhase === 'ready' && messages.length === 0 ? sessionId : null
  const scope = useMemo(() => ({ paneKey, agent }), [paneKey, agent])
  const [cachedPending, setPending] = useState(() => readPendingSendCache(scope))
  const pending = useMemo(
    () => releaseEmptyTranscriptClaims(cachedPending, sessionId),
    [cachedPending, sessionId]
  )
  useEffect(() => setPending(readPendingSendCache(scope)), [scope])
  const save = useCallback(
    (update: (entries: NativeChatPendingSend[]) => NativeChatPendingSend[]) => {
      const current = readPendingSendCache(scope)
      const next = update(current)
      // Stream pruning runs frequently; no-op updates must not rerender the list.
      if (next !== current) {
        setPending(writePendingSendCache(scope, next))
      }
    },
    [scope]
  )
  useEffect(() => {
    save((entries) => prunePendingSends(releaseEmptyTranscriptClaims(entries, sessionId), messages))
  }, [messages, save, sessionId])
  const record = useCallback(
    (text: string, imagePaths?: string[], recovery = false) => {
      const sentAt = Date.now()
      const boundary = messages.at(-1)
      const entry: NativeChatPendingSend = {
        id: nextNativeChatPendingSendId(sentAt),
        text,
        ...(recovery ? { recovery: true } : {}),
        sentAt,
        afterMessageId: boundary?.id ?? null,
        afterMessageTimestamp: boundary?.timestamp ?? null,
        ...(readEmptySessionId ? { afterEmptyTranscriptSessionId: readEmptySessionId } : {}),
        ...(imagePaths ? { imagePaths } : {})
      }
      setPending(appendPendingSendCache(scope, entry))
      return entry.id
    },
    [messages, readEmptySessionId, scope]
  )
  const cancel = useCallback(
    (id: string, discard = false) =>
      save((entries) => entries.filter((entry) => entry.id !== id || (entry.recovery && !discard))),
    [save]
  )
  const reject = useCallback(
    (id: string) =>
      save((entries) =>
        entries.map((entry) => (entry.id === id ? { ...entry, delivery: 'rejected' } : entry))
      ),
    [save]
  )
  const holdUnconfirmed = useCallback(
    (id: string) =>
      save((entries) =>
        entries.map((entry) =>
          entry.id === id &&
          (!entry.delivery || entry.recovery) &&
          entry.writeUnconfirmedAt === undefined
            ? { ...entry, delivery: undefined, writeUnconfirmedAt: Date.now() }
            : entry
        )
      ),
    [save]
  )
  // Stop cannot discard failed or uncertain writes: their bubbles may hold the only message copy.
  const clear = useCallback(
    () =>
      save((entries) =>
        entries.filter(
          (entry) => entry.delivery || entry.recovery || entry.writeUnconfirmedAt !== undefined
        )
      ),
    [save]
  )

  // Only lost acknowledgments trigger uncertainty; acknowledged/queued sends wait for their transcript row.
  const nextHoldDeadline = useMemo(() => {
    const deadlines = pending.flatMap((entry) =>
      entry.writeUnconfirmedAt !== undefined && !entry.delivery
        ? [entry.writeUnconfirmedAt + NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS]
        : []
    )
    return deadlines.length > 0 ? Math.min(...deadlines) : null
  }, [pending])
  useEffect(() => {
    if (nextHoldDeadline === null) {
      return
    }
    const timer = setTimeout(
      () => {
        const now = Date.now()
        save((entries) => {
          const due = entries.filter(
            (entry) =>
              entry.writeUnconfirmedAt !== undefined &&
              !entry.delivery &&
              entry.writeUnconfirmedAt + NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS <= now
          )
          if (due.length === 0) {
            return entries
          }
          const unmatched = new Set(
            pendingSendsAsMessages(releaseEmptyTranscriptClaims(due, sessionId), messages).map(
              (message) => message.id
            )
          )
          if (unmatched.size === 0) {
            return entries
          }
          return entries.map((entry) =>
            due.includes(entry) && unmatched.has(`pending:${entry.id}`)
              ? { ...entry, delivery: 'unconfirmed' as const }
              : entry
          )
        })
      },
      Math.max(0, nextHoldDeadline - Date.now())
    )
    return () => clearTimeout(timer)
  }, [nextHoldDeadline, messages, save, sessionId])

  const notices = useMemo(() => {
    if (!pending.some((entry) => entry.delivery === 'rejected')) {
      return NO_NOTICES
    }
    const result = new Map<string, NativeChatDeliveryNotice>()
    for (const entry of pending) {
      if (entry.delivery !== 'rejected') {
        continue
      }
      result.set(`pending:${entry.id}`, {
        text: translate('components.native-chat.messageNotSent', 'Message not sent'),
        ...(composerRef
          ? {
              onSend: () => {
                if (composerRef.current?.resend?.(entry.text, entry.imagePaths)) {
                  cancel(entry.id, true)
                }
              }
            }
          : {}),
        onEdit: () => {
          if (
            returnMessageToComposer(paneKey, `pending-${entry.id}`, [
              { type: 'text', text: entry.text },
              ...(entry.imagePaths ?? []).map((path) => ({ type: 'image-ref' as const, path }))
            ])
          ) {
            cancel(entry.id, true)
          }
        },
        onDismiss: () => cancel(entry.id, true)
      })
    }
    return result
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- translate() reads the UI language implicitly.
  }, [pending, cancel, paneKey, composerRef, languageRevision])
  return { pending, record, cancel, reject, holdUnconfirmed, clear, notices }
}

export function useNativeChatOptimisticSend(
  record: ReturnType<typeof useNativeChatPendingDelivery>['record'],
  setWorkingInterrupted: (value: boolean) => void
) {
  return useCallback(
    (...input: Parameters<typeof record>) => {
      setWorkingInterrupted(false)
      return record(...input)
    },
    [record, setWorkingInterrupted]
  )
}
