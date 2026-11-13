import type { NativeChatComposerHandle } from '../../../composer/native-chat-composer-types'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentType } from '../../../../../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import {
  pendingSendsAsMessages,
  prunePendingSends,
  releaseEmptyTranscriptClaims,
  type NativeChatPendingDispatchOutcome,
  type NativeChatPendingSend
} from '../../../../../../../shared/native-chat/transcript/native-chat-pending-sends'
import {
  appendPendingSendCache,
  resolvePendingSendEvidence,
  nextNativeChatPendingSendId,
  observePendingSendCache,
  readPendingSendCache,
  writePendingSendCache
} from './native-chat-pending'
import { useNativeChatPendingNotices } from './use-native-chat-pending-notices'
import { useNativeChatDispatchCompletion } from './use-native-chat-dispatch-completion'
import type { NativeChatLiveSession, ReadState } from '../read/native-chat-live-session-contract'

/** Wait for transcript evidence after lost write acknowledgment; mobile uses the same hold. */
export const NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS = 20_000

/** Keep optimistic PTY echoes and definite transport outcomes until reconciliation. */
export function useNativeChatPendingDelivery(args: {
  paneKey: string
  agent: AgentType
  composerRef?: { current: NativeChatComposerHandle | null }
  workingEpoch?: number | null
  /** `readPhase` 'ready' with a `sessionId` means an empty `messages` was a real read. */
  session: {
    messages: NativeChatMessage[]
    readPhase?: ReadState['phase']
    sessionId?: string | null
    sourceObservation?: NativeChatLiveSession['sourceObservation']
  }
}) {
  const { paneKey, agent, composerRef, workingEpoch } = args
  const { messages } = args.session
  const sourceObservation = args.session.sourceObservation
  const sessionId = args.session.sessionId ?? null
  // Without a sessionId, ready is an unread placeholder.
  const readEmptySessionId =
    args.session.readPhase === 'ready' && messages.length === 0 ? sessionId : null
  const scope = useMemo(() => ({ paneKey, agent }), [paneKey, agent])
  const mountedScope = useRef<typeof scope | null>(scope)
  useLayoutEffect(() => {
    mountedScope.current = scope
    return () => {
      mountedScope.current = null
    }
  }, [scope])
  const [cachedPending, setPending] = useState(() => readPendingSendCache(scope))
  const pending = useMemo(
    () => releaseEmptyTranscriptClaims(cachedPending, sessionId),
    [cachedPending, sessionId]
  )
  const [prevScope, setPrevScope] = useState(scope)
  if (prevScope !== scope) {
    setPrevScope(scope)
    setPending(readPendingSendCache(scope))
  }
  const save = useCallback(
    (update: (entries: NativeChatPendingSend[]) => NativeChatPendingSend[]) => {
      const current = readPendingSendCache(scope)
      const next = update(current)
      // Stream pruning runs frequently; no-op updates must not rerender the list.
      const saved = next !== current ? writePendingSendCache(scope, next) : current
      if (mountedScope.current === scope) {
        setPending(saved)
      }
    },
    [scope]
  )
  useEffect(() => {
    if (args.session.readPhase === 'ready' && sessionId) {
      observePendingSendCache(
        scope,
        sourceObservation?.messages ?? messages,
        sessionId,
        sourceObservation?.generation
      )
    }
    save((entries) =>
      prunePendingSends(releaseEmptyTranscriptClaims(entries, sessionId), messages, sessionId ?? '')
    )
  }, [messages, sourceObservation, save, sessionId, scope, args.session.readPhase])
  const finishDispatch = useNativeChatDispatchCompletion({
    scope,
    pending,
    save,
    messages,
    sessionId
  })
  const record = useCallback(
    (
      text: string,
      imagePaths?: string[],
      recovery = false,
      sourceAgent?: AgentType,
      dispatchOutcome?: Promise<NativeChatPendingDispatchOutcome>
    ) => {
      const sentAt = Date.now()
      const boundary = messages.at(-1)
      const entry: NativeChatPendingSend = {
        id: nextNativeChatPendingSendId(sentAt),
        text,
        ...(sourceAgent ? { sourceAgent, evidenceModePending: true } : {}),
        ...(sourceAgent && dispatchOutcome ? { dispatchPending: true, dispatchOutcome } : {}),
        ...(recovery ? { recovery: true } : {}),
        sentAt,
        ...(workingEpoch !== undefined ? { queuedDuringWorkingEpoch: workingEpoch } : {}),
        afterMessageId: boundary?.id ?? null,
        afterMessageTimestamp: boundary?.timestamp ?? null,
        ...(readEmptySessionId ? { afterEmptyTranscriptSessionId: readEmptySessionId } : {}),
        ...(imagePaths ? { imagePaths } : {})
      }
      setPending(appendPendingSendCache(scope, entry, sessionId))
      return entry.id
    },
    [messages, readEmptySessionId, scope, workingEpoch, sessionId]
  )
  const setSourceEvidence = useCallback(
    (id: string, source: boolean) =>
      save((entries) => resolvePendingSendEvidence(entries, id, agent, source)),
    [agent, save]
  )
  const finishSourceEvidence = useCallback(
    (id: string) => save((entries) => resolvePendingSendEvidence(entries, id, agent)),
    [agent, save]
  )
  const cancel = useCallback(
    (id: string, discard = false) =>
      save((entries) =>
        entries.filter(
          (entry) => entry.id !== id || ((entry.recovery || entry.sourceAgent) && !discard)
        )
      ),
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
          (entry) =>
            entry.delivery ||
            entry.recovery ||
            entry.sourceAgent ||
            entry.writeUnconfirmedAt !== undefined
        )
      ),
    [save]
  )

  const authoritative = args.session.readPhase === 'ready' && sessionId !== null
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
              sessionId ?? ''
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
  }, [nextHoldDeadline, messages, save, sessionId, observing, workingEpoch])

  const notices = useNativeChatPendingNotices({ pending, cancel, paneKey, composerRef })

  return {
    pending,
    record,
    cancel,
    setSourceEvidence,
    finishSourceEvidence,
    finishDispatch,
    reject,
    holdUnconfirmed,
    clear,
    notices
  }
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
