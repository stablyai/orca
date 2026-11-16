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

const ACTIVE_POLL_MS = 1_500
const IDLE_POLL_MS = 6_000

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
  const [transcriptState, setTranscriptState] = useState<{
    sessionId: string
    conversationId: string | null
    result: AgentSessionSwarmTranscriptResult | null
  }>({ sessionId, conversationId: null, result: null })
  const [transcriptLoading, setTranscriptLoading] = useState(false)

  const isUnsupported = unsupportedFor === sessionId
  const mayHaveSwarmNow = mayHaveSwarm && !isUnsupported
  const snapshot = snapshotState.sessionId === sessionId ? snapshotState.snapshot : null
  const error = snapshotState.sessionId === sessionId ? snapshotState.error : null
  const selectedConversationId =
    selectedConversation.sessionId === sessionId ? selectedConversation.conversationId : null
  const transcript =
    transcriptState.sessionId === sessionId &&
    transcriptState.conversationId === selectedConversationId
      ? transcriptState.result
      : null

  const isOpen = isVisible && openFor === sessionId
  const etagRef = useRef<{ sessionId: string; etag: string } | null>(null)
  const requestSeqRef = useRef(0)
  const transcriptSeqRef = useRef(0)

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
      try {
        const result = await callStructuredAgentSession<AgentSessionSwarmReadResult>(
          target,
          'agentSession.swarmRead',
          {
            sessionId,
            ...(force || !activeEtag ? {} : { ifNoneMatch: activeEtag })
          }
        )
        if (requestSeqRef.current !== seq) {
          return
        }
        if (result.status === 'unchanged') {
          setSnapshotState((prev) =>
            prev.sessionId === sessionId ? { ...prev, error: null } : prev
          )
        } else if (result.status === 'ok') {
          etagRef.current = { sessionId, etag: result.snapshot.etag }
          setSnapshotState({ sessionId, snapshot: result.snapshot, error: null })
        } else if (result.status === 'unsupported') {
          if (etagRef.current?.sessionId === sessionId) {
            etagRef.current = null
          }
          setUnsupportedFor(sessionId)
          setSnapshotState({ sessionId, snapshot: null, error: null })
        } else if (result.status === 'none') {
          if (etagRef.current?.sessionId === sessionId) {
            etagRef.current = null
          }
          setSnapshotState({ sessionId, snapshot: null, error: null })
        } else {
          setSnapshotState((prev) => ({
            sessionId,
            snapshot: prev.sessionId === sessionId ? prev.snapshot : null,
            error: result.message ?? 'Failed to load swarm board'
          }))
        }
      } catch (err) {
        if (requestSeqRef.current !== seq) {
          return
        }
        setSnapshotState((prev) => ({
          sessionId,
          snapshot: prev.sessionId === sessionId ? prev.snapshot : null,
          error: err instanceof Error ? err.message : 'Failed to load swarm board'
        }))
      } finally {
        if (requestSeqRef.current === seq) {
          setLoading(false)
        }
      }
    },
    [mayHaveSwarmNow, sessionId, target]
  )

  const fetchTranscript = useCallback(
    async (conversationId: string) => {
      const seq = ++transcriptSeqRef.current
      setTranscriptLoading(true)
      try {
        const result = await callStructuredAgentSession<AgentSessionSwarmTranscriptResult>(
          target,
          'agentSession.swarmMemberTranscript',
          { sessionId, conversationId, maxEntries: 200 }
        )
        if (transcriptSeqRef.current !== seq) {
          return
        }
        setTranscriptState({ sessionId, conversationId, result })
      } catch (err) {
        if (transcriptSeqRef.current !== seq) {
          return
        }
        setTranscriptState({
          sessionId,
          conversationId,
          result: {
            status: 'failed',
            message: err instanceof Error ? err.message : 'Failed to read worker transcript'
          }
        })
      } finally {
        if (transcriptSeqRef.current === seq) {
          setTranscriptLoading(false)
        }
      }
    },
    [sessionId, target]
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

  const selectedMemberStamp = useMemo(() => {
    if (!selectedConversationId || !snapshot) {
      return ''
    }
    const member = snapshot.members.find((m) => m.conversationId === selectedConversationId)
    return member ? `${member.steps}:${member.transcriptMtime}` : ''
  }, [selectedConversationId, snapshot])

  useEffect(() => {
    if (!isOpen || !selectedConversationId) {
      return
    }
    void fetchTranscript(selectedConversationId)
  }, [fetchTranscript, isOpen, selectedConversationId, selectedMemberStamp])

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
    if (selectedConversationId) {
      void fetchTranscript(selectedConversationId)
    }
  }, [fetchSnapshot, fetchTranscript, selectedConversationId])

  const refreshTranscript = useCallback(() => {
    if (selectedConversationId) {
      void fetchTranscript(selectedConversationId)
    }
  }, [fetchTranscript, selectedConversationId])

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
