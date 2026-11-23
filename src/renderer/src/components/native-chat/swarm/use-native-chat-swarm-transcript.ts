import { useCallback, useEffect, useRef, useState } from 'react'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import type {
  AgentSessionSwarmTranscriptResult,
  AntigravitySwarmSnapshot
} from '../../../../../shared/agent-session/antigravity-swarm-wire'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

async function readSwarmTranscript(
  target: RuntimeClientTarget,
  sessionId: string,
  conversationId: string
): Promise<AgentSessionSwarmTranscriptResult> {
  try {
    return await callStructuredAgentSession<AgentSessionSwarmTranscriptResult>(
      target,
      'agentSession.swarmMemberTranscript',
      { sessionId, conversationId, maxEntries: 200 }
    )
  } catch (err) {
    return {
      status: 'failed',
      message: err instanceof Error ? err.message : 'Failed to read worker transcript'
    }
  }
}

export function useNativeChatSwarmTranscript(args: {
  target: RuntimeClientTarget
  sessionId: string
  isOpen: boolean
  selectedConversationId: string | null
  snapshot: AntigravitySwarmSnapshot | null
}) {
  const { target, sessionId, isOpen, selectedConversationId, snapshot } = args
  const [transcriptState, setTranscriptState] = useState<{
    sessionId: string
    conversationId: string | null
    result: AgentSessionSwarmTranscriptResult | null
  }>({ sessionId, conversationId: null, result: null })
  const [transcriptLoading, setTranscriptLoading] = useState(false)

  const transcript =
    transcriptState.sessionId === sessionId &&
    transcriptState.conversationId === selectedConversationId
      ? transcriptState.result
      : null

  const transcriptSeqRef = useRef(0)
  const transcriptFlightRef = useRef<{
    epoch: number
    sessionId: string
    conversationId: string
    target: RuntimeClientTarget
    inFlight: boolean
    pendingFollowUp: boolean
  } | null>(null)

  const fetchTranscript = useCallback(
    async (conversationId: string) => {
      const current = transcriptFlightRef.current
      if (
        current?.inFlight &&
        current.sessionId === sessionId &&
        current.conversationId === conversationId &&
        current.target === target
      ) {
        // Coalesce stamp updates while a read is in flight so slow reads never starve.
        current.pendingFollowUp = true
        return
      }
      const epoch = ++transcriptSeqRef.current
      const flight = {
        epoch,
        sessionId,
        conversationId,
        target,
        inFlight: true,
        pendingFollowUp: false
      }
      transcriptFlightRef.current = flight
      setTranscriptLoading(true)
      while (transcriptSeqRef.current === epoch) {
        flight.pendingFollowUp = false
        const result = await readSwarmTranscript(target, sessionId, conversationId)
        if (transcriptSeqRef.current !== epoch) {
          return
        }
        setTranscriptState({ sessionId, conversationId, result })
        if (!flight.pendingFollowUp) {
          flight.inFlight = false
          setTranscriptLoading(false)
          return
        }
      }
    },
    [sessionId, target]
  )

  const selectedMember = selectedConversationId
    ? snapshot?.members.find((m) => m.conversationId === selectedConversationId)
    : undefined
  const selectedMemberStamp = selectedMember
    ? `${selectedMember.steps}:${selectedMember.transcriptMtime}`
    : ''

  useEffect(() => {
    if (!isOpen || !selectedConversationId) {
      transcriptSeqRef.current += 1
      transcriptFlightRef.current = null
      setTranscriptLoading(false)
      return
    }
    void fetchTranscript(selectedConversationId)
  }, [fetchTranscript, isOpen, selectedConversationId, selectedMemberStamp])

  useEffect(() => {
    return () => {
      transcriptSeqRef.current += 1
      transcriptFlightRef.current = null
    }
  }, [sessionId, target])

  const refreshTranscript = useCallback(() => {
    if (selectedConversationId) {
      void fetchTranscript(selectedConversationId)
    }
  }, [fetchTranscript, selectedConversationId])

  return {
    transcript,
    transcriptLoading,
    refreshTranscript
  }
}
