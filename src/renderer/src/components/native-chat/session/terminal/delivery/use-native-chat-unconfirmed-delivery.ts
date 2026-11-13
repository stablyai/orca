import { useCallback, useEffect, useMemo } from 'react'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatSourceContext } from '../../../../../../../shared/native-chat/input/native-chat-prompt-observation'
import {
  pendingSendsAsMessages,
  releaseEmptyTranscriptClaims,
  type NativeChatPendingSend
} from '../../../../../../../shared/native-chat/transcript/native-chat-pending-sends'
import type { ReadState } from '../read/native-chat-live-session-contract'
/** Wait for transcript evidence after lost write acknowledgment; mobile uses the same hold. */
export const NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS = 20_000
export function useNativeChatUnconfirmedDelivery({
  pending,
  save,
  messages,
  readPhase,
  sessionId,
  workingEpoch,
  sourceContext
}: {
  pending: NativeChatPendingSend[]
  save: (update: (entries: NativeChatPendingSend[]) => NativeChatPendingSend[]) => void
  messages: NativeChatMessage[]
  readPhase?: ReadState['phase']
  sessionId: string | null
  workingEpoch?: number | null
  sourceContext?: NativeChatSourceContext
}): void {
  const authoritative = readPhase === 'ready' && sessionId !== null
  const observing = useCallback(
    (entry: NativeChatPendingSend) =>
      authoritative &&
      !(
        typeof entry.queuedDuringWorkingEpoch === 'number' &&
        entry.queuedDuringWorkingEpoch === workingEpoch
      ),
    [authoritative, workingEpoch]
  )
  useEffect(() => {
    if (
      !pending.some(
        (entry) => entry.sourceAgent && entry.writeUnconfirmedAt !== undefined && !entry.delivery
      )
    ) {
      return
    }
    save((entries) => {
      let changed = false
      const next = entries.map((entry) => {
        if (!entry.sourceAgent || entry.writeUnconfirmedAt === undefined || entry.delivery) {
          return entry
        }
        const owner = observing(entry) ? sessionId : undefined
        if (entry.writeUnconfirmedSessionId === owner) {
          return entry
        }
        changed = true
        return {
          ...entry,
          writeUnconfirmedSessionId: owner ?? undefined,
          writeUnconfirmedAt: Date.now()
        }
      })
      return changed ? next : entries
    })
  }, [observing, pending, save, sessionId])

  // Only lost acknowledgments trigger uncertainty; acknowledged/queued sends wait for their transcript row.
  const nextHoldDeadline = useMemo(() => {
    const deadlines = pending.flatMap((entry) =>
      entry.writeUnconfirmedAt !== undefined &&
      !entry.delivery &&
      (!entry.sourceAgent || (observing(entry) && entry.writeUnconfirmedSessionId === sessionId))
        ? [entry.writeUnconfirmedAt + NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS]
        : []
    )
    return deadlines.length > 0 ? Math.min(...deadlines) : null
  }, [pending, observing, sessionId])
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
              (!entry.sourceAgent ||
                (observing(entry) && entry.writeUnconfirmedSessionId === sessionId)) &&
              entry.writeUnconfirmedAt + NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS <= now
          )
          if (due.length === 0) {
            return entries
          }
          const unmatched = new Set(
            pendingSendsAsMessages(
              releaseEmptyTranscriptClaims(entries, sessionId),
              messages,
              workingEpoch,
              sessionId ?? '',
              sourceContext
            ).map((message) => message.id)
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
  }, [nextHoldDeadline, messages, save, sessionId, observing, workingEpoch, sourceContext])
}
