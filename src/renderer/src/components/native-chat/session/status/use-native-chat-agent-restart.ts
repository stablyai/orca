import { useCallback, useEffect, useMemo, useState } from 'react'
import { canResumePaneAgent, restartPaneAgent } from '@/lib/agent-session/resume/pane-agent-restart'
import type {
  PaneAgentRestartMode,
  PaneAgentRestartRefusal
} from '../../../../../../shared/native-chat/agent-presence/pane-agent-restart-contract'

// Why: past this the agent never reported back; the notice keeps its buttons for another try.
const AGENT_RESTART_SETTLE_MS = 60_000

export type NativeChatAgentRestartPhase =
  | { kind: 'idle' }
  /** `sessionId` is set when a running agent is replaced: done once the chat shows that session. */
  | { kind: 'restarting'; mode: PaneAgentRestartMode; sessionId?: string }
  | { kind: 'failed'; mode: PaneAgentRestartMode; reason: PaneAgentRestartRefusal }

export type NativeChatAgentRestart = {
  phase: NativeChatAgentRestartPhase
  canResume: boolean
  restart: (mode: PaneAgentRestartMode) => void
}

/** Resume or start the pane's agent again in place; settles when the chat sees it running. */
export function useNativeChatAgentRestart(args: {
  paneKey: string
  agent: string
  /** The conversation to bring back: the exited one, or the one a restart left behind. */
  sessionId: string | null
  transcriptPath: string | null
  /** The conversation the chat shows now. */
  shownSessionId: string | null
  /** The chat sees no running agent. */
  exited: boolean
  /** The conversation is back; any note about the session it replaced is stale. */
  onRestored: () => void
}): NativeChatAgentRestart {
  const { paneKey, agent, sessionId, transcriptPath, shownSessionId, exited, onRestored } = args
  const [phase, setPhase] = useState<NativeChatAgentRestartPhase>({ kind: 'idle' })
  // A new exit starts without the last one's failure; a restart in flight rides through its own stop.
  const [seenExited, setSeenExited] = useState(exited)
  if (seenExited !== exited) {
    setSeenExited(exited)
    if (phase.kind === 'failed') {
      setPhase({ kind: 'idle' })
    }
  }
  const settled =
    phase.kind === 'restarting' &&
    !exited &&
    (phase.sessionId === undefined || phase.sessionId === shownSessionId)
  // Both setters belong to this component's own hooks, so they may run during render.
  if (settled) {
    setPhase({ kind: 'idle' })
    if (phase.sessionId !== undefined) {
      onRestored()
    }
  }
  const canResume = useMemo(
    () => canResumePaneAgent({ paneKey, agent, sessionId, transcriptPath }),
    [paneKey, agent, sessionId, transcriptPath]
  )
  const restart = useCallback(
    (mode: PaneAgentRestartMode) => {
      const result = restartPaneAgent({ paneKey, mode, agent, sessionId, transcriptPath })
      if (!result.ok) {
        setPhase({ kind: 'failed', mode, reason: result.reason })
        return
      }
      // Replacing a running agent: wait for the chat to show the resumed conversation.
      setPhase(
        !exited && mode === 'resume' && sessionId
          ? { kind: 'restarting', mode, sessionId }
          : { kind: 'restarting', mode }
      )
    },
    [paneKey, agent, sessionId, transcriptPath, exited]
  )
  useEffect(() => {
    if (phase.kind !== 'restarting') {
      return
    }
    const settle = setTimeout(
      () => setPhase({ kind: 'failed', mode: phase.mode, reason: 'failed' }),
      AGENT_RESTART_SETTLE_MS
    )
    return () => clearTimeout(settle)
  }, [phase])
  return useMemo(() => ({ phase, canResume, restart }), [phase, canResume, restart])
}
