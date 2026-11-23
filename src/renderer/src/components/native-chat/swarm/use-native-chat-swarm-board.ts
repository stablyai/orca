import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentSessionSlashCommand } from '../../../../../shared/agent-session/agent-session-wire'
import type {
  AgentSessionSwarmReadResult,
  AgentSessionSwarmTranscriptResult,
  AntigravitySwarmSnapshot
} from '../../../../../shared/agent-session/antigravity-swarm-wire'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useNativeChatSwarmTranscript } from './use-native-chat-swarm-transcript'

const ACTIVE_POLL_MS = 1_500
const IDLE_POLL_MS = 6_000

async function readSwarmSnapshot(
  target: RuntimeClientTarget,
  sessionId: string,
  ifNoneMatch?: string
): Promise<{ result: AgentSessionSwarmReadResult } | { error: string }> {
  try {
    const result = await callStructuredAgentSession<AgentSessionSwarmReadResult>(
      target,
      'agentSession.swarmRead',
      { sessionId, ...(ifNoneMatch ? { ifNoneMatch } : {}) }
    )
    return { result }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to load swarm board' }
  }
}

export type NativeChatSwarmBoardState = {
  canOpen: boolean
  isOpen: boolean
  open: () => void
  close: () => void
  toggle: () => void
  snapshot: AntigravitySwarmSnapshot | null
  loading: boolean
  error: string | null
  refresh: () => void
  selectedConversationId: string | null
  selectMemberConversation: (conversationId: string | null) => void
  transcript: AgentSessionSwarmTranscriptResult | null
  transcriptLoading: boolean
  refreshTranscript: () => void
}

export function useNativeChatSwarmBoard(args: {
  agent: AgentType
  sessionId: string
  target: RuntimeClientTarget
  isVisible: boolean
  isWorking: boolean
  sessionCommands?: readonly AgentSessionSlashCommand[]
}): NativeChatSwarmBoardState {
  const { agent, sessionId, target, isVisible, isWorking, sessionCommands } = args
  const isAntigravity = agent === 'antigravity'
  const sessionReportsSwarm = sessionCommands?.some((entry) => entry.name === 'swarm') === true
  const mayHaveSwarm = isAntigravity && (sessionCommands === undefined || sessionReportsSwarm)

  const [openFor, setOpenFor] = useState<string | null>(null)
  const [unsupportedFor, setUnsupportedFor] = useState<string | null>(null)
  const [snapshotState, setSnapshotState] = useState<{
    sessionId: string
    snapshot: AntigravitySwarmSnapshot | null
    error: string | null
  }>({ sessionId, snapshot: null, error: null })
  const [loading, setLoading] = useState(false)
  const [selectedConversation, setSelectedConversation] = useState<{
    sessionId: string
    conversationId: string | null
  }>({ sessionId, conversationId: null })

  const isUnsupported = unsupportedFor === sessionId
  const mayHaveSwarmNow = mayHaveSwarm && !isUnsupported
  const snapshot = snapshotState.sessionId === sessionId ? snapshotState.snapshot : null
  const error = snapshotState.sessionId === sessionId ? snapshotState.error : null
  const selectedConversationId =
    selectedConversation.sessionId === sessionId ? selectedConversation.conversationId : null
  const isOpen = isVisible && openFor === sessionId

  const { transcript, transcriptLoading, refreshTranscript } = useNativeChatSwarmTranscript({
    target,
    sessionId,
    isOpen,
    selectedConversationId,
    snapshot
  })

  const etagRef = useRef<{ sessionId: string; etag: string } | null>(null)
  const requestSeqRef = useRef(0)

  // Send an ETag only while snapshotState actually holds a snapshot for the active session.
  useEffect(() => {
    etagRef.current =
      snapshotState.sessionId === sessionId && snapshotState.snapshot !== null
        ? { sessionId, etag: snapshotState.snapshot.etag }
        : null
  }, [sessionId, snapshotState])

  useEffect(() => {
    if (!isVisible) {
      return
    }
    return () => setOpenFor(null)
  }, [isVisible])

  const fetchSnapshot = useCallback(
    async (force = false) => {
      if (!mayHaveSwarmNow) {
        return
      }
      const seq = ++requestSeqRef.current
      const activeEtag = etagRef.current?.sessionId === sessionId ? etagRef.current.etag : undefined
      if (force || !activeEtag) {
        setLoading(true)
      }
      const response = await readSwarmSnapshot(
        target,
        sessionId,
        force || !activeEtag ? undefined : activeEtag
      )
      if (requestSeqRef.current !== seq) {
        return
      }
      setLoading(false)
      if ('error' in response) {
        if (etagRef.current?.sessionId !== sessionId) {
          etagRef.current = null
        }
        setSnapshotState((prev) => ({
          sessionId,
          snapshot: prev.sessionId === sessionId ? prev.snapshot : null,
          error: response.error
        }))
        return
      }
      const { result } = response
      if (result.status === 'unchanged') {
        setSnapshotState((prev) => (prev.sessionId === sessionId ? { ...prev, error: null } : prev))
      } else if (result.status === 'ok') {
        etagRef.current = { sessionId, etag: result.snapshot.etag }
        setSnapshotState({ sessionId, snapshot: result.snapshot, error: null })
      } else if (result.status === 'unsupported') {
        etagRef.current = null
        setUnsupportedFor(sessionId)
        setSnapshotState({ sessionId, snapshot: null, error: null })
      } else if (result.status === 'none') {
        etagRef.current = null
        setSnapshotState({ sessionId, snapshot: null, error: null })
      } else {
        if (etagRef.current?.sessionId !== sessionId) {
          etagRef.current = null
        }
        setSnapshotState((prev) => ({
          sessionId,
          snapshot: prev.sessionId === sessionId ? prev.snapshot : null,
          error: result.message ?? 'Failed to load swarm board'
        }))
      }
    },
    [mayHaveSwarmNow, sessionId, target]
  )

  const hasSnapshot = snapshot !== null
  const hasActiveWorker = Boolean(
    snapshot?.members.some((member) => !member.killed && member.status === 'working')
  )

  useEffect(() => {
    if (!isVisible || !mayHaveSwarmNow) {
      return
    }
    let cancelled = false
    let timer: number | undefined
    const shouldPoll = isOpen || isWorking || hasSnapshot
    const intervalMs = isOpen || hasActiveWorker || isWorking ? ACTIVE_POLL_MS : IDLE_POLL_MS

    const run = async () => {
      await fetchSnapshot(false)
      if (cancelled || !shouldPoll) {
        return
      }
      timer = window.setTimeout(() => {
        void run()
      }, intervalMs)
    }

    void run()
    return () => {
      cancelled = true
      if (timer !== undefined) {
        window.clearTimeout(timer)
      }
    }
  }, [fetchSnapshot, hasActiveWorker, hasSnapshot, isOpen, isVisible, isWorking, mayHaveSwarmNow])

  const open = useCallback(() => {
    setOpenFor(sessionId)
    void fetchSnapshot(true)
  }, [fetchSnapshot, sessionId])

  const close = useCallback(() => {
    setOpenFor(null)
    setSelectedConversation({ sessionId, conversationId: null })
  }, [sessionId])

  const selectMemberConversation = useCallback(
    (conversationId: string | null) => {
      setSelectedConversation({ sessionId, conversationId })
    },
    [sessionId]
  )

  const toggle = useCallback(() => {
    if (isOpen) {
      close()
    } else {
      open()
    }
  }, [close, isOpen, open])

  const refresh = useCallback(() => {
    void fetchSnapshot(true)
    refreshTranscript()
  }, [fetchSnapshot, refreshTranscript])

  const canOpen = isAntigravity && !isUnsupported && (sessionReportsSwarm || snapshot !== null)

  return useMemo(
    () => ({
      canOpen,
      isOpen,
      open,
      close,
      toggle,
      snapshot,
      loading,
      error,
      refresh,
      selectedConversationId,
      selectMemberConversation,
      transcript,
      transcriptLoading,
      refreshTranscript
    }),
    [
      canOpen,
      close,
      error,
      isOpen,
      loading,
      open,
      refresh,
      refreshTranscript,
      selectMemberConversation,
      selectedConversationId,
      snapshot,
      toggle,
      transcript,
      transcriptLoading
    ]
  )
}
