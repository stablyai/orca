import { useNativeChatUnconfirmedDelivery } from './use-native-chat-unconfirmed-delivery'
export { NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS } from './use-native-chat-unconfirmed-delivery'
import {
  resolvePendingSendEvidence,
  rejectPendingSend
} from './native-chat-optimistic-send-outcome'
import type { NativeChatComposerHandle } from '../../../composer/native-chat-composer-types'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentType } from '../../../../../../../shared/agent-status/contracts/agent-status-types'
import type {
  NativeChatPromptDispatch,
  NativeChatPromptSubmission
} from '../../../../../../../shared/native-chat/input/native-chat-prompt-observation'
import { useAppStore } from '@/store/index'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import {
  prunePendingSends,
  releaseEmptyTranscriptClaims,
  type NativeChatPendingDispatchOutcome,
  type NativeChatPendingSend
} from '../../../../../../../shared/native-chat/transcript/native-chat-pending-sends'
import {
  appendPendingSendCache,
  associatePendingPromptSubmissions,
  nextNativeChatPendingSendId,
  observePendingSendCache,
  readPendingSendCache,
  writePendingSendCache
} from './native-chat-pending'
import { useNativeChatPendingNotices } from './use-native-chat-pending-notices'
import { useNativeChatDispatchCompletion } from './use-native-chat-dispatch-completion'
import type { NativeChatLiveSession, ReadState } from '../read/native-chat-live-session-contract'

const EMPTY_PROMPT_SUBMISSIONS: readonly NativeChatPromptSubmission[] = []

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
  const sourceContext = sourceObservation?.context
  const promptSubmissions = useAppStore(
    (state) => state.agentStatusByPaneKey[paneKey]?.promptSubmissions ?? EMPTY_PROMPT_SUBMISSIONS
  )
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
        sourceObservation?.generation,
        sourceContext
      )
    }
    const entries = readPendingSendCache(scope)
    const next = prunePendingSends(
      releaseEmptyTranscriptClaims(
        associatePendingPromptSubmissions(scope, entries, promptSubmissions),
        sessionId
      ),
      messages,
      sessionId ?? '',
      sourceContext
    )
    if (next !== cachedPending) {
      save(() => next)
    }
  }, [
    messages,
    sourceObservation,
    sourceContext,
    promptSubmissions,
    cachedPending,
    save,
    sessionId,
    scope,
    args.session.readPhase
  ])
  const finishDispatch = useNativeChatDispatchCompletion({
    scope,
    pending,
    save,
    messages,
    sessionId,
    sourceContext
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
        ...(sourceAgent && sessionId ? { sourceSessionId: sessionId } : {}),
        ...(sourceAgent && sourceContext?.sessionId ? { sourceContext } : {}),
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
    [messages, readEmptySessionId, scope, workingEpoch, sessionId, sourceContext]
  )
  const setPromptBinding = useCallback(
    (id: string, binding: NativeChatPromptDispatch) =>
      save((entries) =>
        entries.map((entry) =>
          entry.id === id && entry.sourceAgent && entry.dispatchPending
            ? { ...entry, promptBinding: binding }
            : entry
        )
      ),
    [save]
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
    (id: string) => save((entries) => rejectPendingSend(entries, id)),
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

  useNativeChatUnconfirmedDelivery({
    pending,
    save,
    messages,
    readPhase: args.session.readPhase,
    sessionId,
    workingEpoch,
    sourceContext
  })

  const notices = useNativeChatPendingNotices({ pending, cancel, paneKey, composerRef })

  return {
    pending,
    record,
    setPromptBinding,
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
