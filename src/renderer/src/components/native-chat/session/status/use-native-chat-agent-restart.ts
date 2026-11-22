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
  | { kind: 'restarting'; mode: PaneAgentRestartMode }
  | { kind: 'failed'; mode: PaneAgentRestartMode; reason: PaneAgentRestartRefusal }

export type NativeChatAgentRestart = {
  phase: NativeChatAgentRestartPhase
  canResume: boolean
  restart: (mode: PaneAgentRestartMode) => void
}

/** Resume or start the pane's agent again in place; settles when the chat sees an agent running. */
export function useNativeChatAgentRestart(args: {
  paneKey: string
  agent: string
  /** The conversation to bring back: the exited one, or the one a restart left behind. */
  sessionId: string | null
  transcriptPath: string | null
  /** The chat sees no running agent; a restart waits for one. */
  exited: boolean
  /** A restart that leaves a running agent's note behind closes that note at once. */
  onRestartedRunning: () => void
}): NativeChatAgentRestart {
  const { paneKey, agent, sessionId, transcriptPath, exited, onRestartedRunning } = args
  const [phase, setPhase] = useState<NativeChatAgentRestartPhase>({ kind: 'idle' })
  // An agent coming back settles a restart; a new exit starts without the last one's failure.
  const [seenExited, setSeenExited] = useState(exited)
  if (seenExited !== exited) {
    setSeenExited(exited)
    setPhase({ kind: 'idle' })
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
      } else if (exited) {
        setPhase({ kind: 'restarting', mode })
      } else {
        setPhase({ kind: 'idle' })
        onRestartedRunning()
      }
    },
    [paneKey, agent, sessionId, transcriptPath, exited, onRestartedRunning]
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
