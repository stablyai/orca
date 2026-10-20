import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NativeChatReadSessionResult } from '../../../../preload/api-types'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { isNativeChatSupportedAgent } from '../../../../shared/native-chat-agent-support'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from '../native-chat/native-chat-live-session-contract'
import {
  NATIVE_CHAT_INITIAL_LIMIT,
  hasMoreNativeChatHistory,
  nextNativeChatLimit,
  type NativeChatOlderPageResult
} from '../native-chat/native-chat-pagination'

// Why: the board reads a transcript no live pane owns, so this adapter feeds the real
// chat renderer (`NativeChatMessageList`) a synthesized session instead of hand-rolling
// a second, lesser conversation view.

type ReadOutcome =
  | { kind: 'unsupported' }
  | { kind: 'loading' }
  | { kind: 'ready'; messages: NativeChatMessage[] }
  | { kind: 'notWritten' }
  | { kind: 'error'; message: string }

export type SessionsConversationPhase = ReadOutcome['kind']

export type ReadOnlyNativeChat = {
  phase: SessionsConversationPhase
  /** Set only when `phase === 'error'`. */
  error: string | null
  /** Set only when `phase === 'ready'`. */
  transcript: NativeChatLiveSession | null
  /** Re-reads from the top; the transcript may have been written since. */
  retry: () => void
  loadEarlier: () => Promise<NativeChatOlderPageResult>
}

export function useReadOnlyNativeChat(session: AiVaultSession): ReadOnlyNativeChat {
  const supported = isNativeChatSupportedAgent(session.agent)
  const { agent, sessionId, filePath } = session
  const [outcome, setOutcome] = useState<ReadOutcome>(() =>
    supported ? { kind: 'loading' } : { kind: 'unsupported' }
  )
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [generation, setGeneration] = useState(0)
  // A ref, not state: growing the window must not re-run the initial-read effect, which
  // would race the older-page read the growth belongs to.
  const limitRef = useRef(NATIVE_CHAT_INITIAL_LIMIT)

  useEffect(() => {
    if (!supported) {
      return
    }
    let cancelled = false
    limitRef.current = NATIVE_CHAT_INITIAL_LIMIT
    setOutcome({ kind: 'loading' })
    setLoadingEarlier(false)
    void window.api.nativeChat
      .readSession(agent, sessionId, NATIVE_CHAT_INITIAL_LIMIT, filePath)
      .then((result) => {
        if (cancelled) {
          return
        }
        setOutcome(readOutcome(result))
        setHasMore(
          'error' in result
            ? false
            : hasMoreNativeChatHistory(result.messages.length, NATIVE_CHAT_INITIAL_LIMIT)
        )
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setOutcome({ kind: 'error', message: readFailureMessage(error) })
        }
      })
    return () => {
      cancelled = true
    }
  }, [supported, agent, sessionId, filePath, generation])

  const loadEarlier = useCallback(async (): Promise<NativeChatOlderPageResult> => {
    if (!supported) {
      return 'unchanged'
    }
    const requestedLimit = nextNativeChatLimit(limitRef.current)
    limitRef.current = requestedLimit
    setLoadingEarlier(true)
    try {
      const result = await window.api.nativeChat.readSession(
        agent,
        sessionId,
        requestedLimit,
        filePath
      )
      if ('error' in result) {
        return 'failed'
      }
      setOutcome({ kind: 'ready', messages: result.messages })
      const more = hasMoreNativeChatHistory(result.messages.length, requestedLimit)
      setHasMore(more)
      return more ? 'applied' : 'exhausted'
    } catch {
      return 'failed'
    } finally {
      setLoadingEarlier(false)
    }
  }, [supported, agent, sessionId, filePath])

  const transcript = useMemo<NativeChatLiveSession | null>(() => {
    if (outcome.kind !== 'ready') {
      return null
    }
    return {
      messages: outcome.messages,
      status: 'ready',
      sessionId,
      agent,
      hasMore,
      loadingEarlier,
      olderHistoryGeneration: generation,
      loadEarlier,
      readPhase: 'ready'
    }
  }, [outcome, hasMore, loadingEarlier, generation, loadEarlier, sessionId, agent])

  return {
    phase: outcome.kind,
    error: outcome.kind === 'error' ? outcome.message : null,
    transcript,
    retry: useCallback(() => setGeneration((current) => current + 1), []),
    loadEarlier
  }
}

function readOutcome(result: NativeChatReadSessionResult): ReadOutcome {
  if ('error' in result) {
    // Why: a transcript that is not on disk yet is a pending write, not a failure —
    // the reader gets a retry rather than an error.
    return result.notFound === true
      ? { kind: 'notWritten' }
      : { kind: 'error', message: result.error }
  }
  return { kind: 'ready', messages: result.messages }
}

function readFailureMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}
