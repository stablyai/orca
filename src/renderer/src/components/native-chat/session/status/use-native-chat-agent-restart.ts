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
  /** `sessionId` keeps the conversation the failed attempt targeted, so a retry asks for it again. */
  | {
      kind: 'failed'
      mode: PaneAgentRestartMode
      reason: PaneAgentRestartRefusal
      sessionId?: string
    }

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
      // Why: the exit of the agent a resume replaced can move `sessionId` to that stopped one.
      const retried = phase.kind === 'failed' && mode === 'resume' ? phase.sessionId : undefined
      const target = retried ?? sessionId
      const result = restartPaneAgent({
        paneKey,
        mode,
        agent,
        sessionId: target,
        transcriptPath: retried && retried !== sessionId ? null : transcriptPath
      })
      if (!result.ok) {
        setPhase({
          kind: 'failed',
          mode,
          reason: result.reason,
          ...(retried ? { sessionId: retried } : {})
        })
        return
      }
      // Replacing a running agent: wait for the chat to show the resumed conversation.
      setPhase(
        (!exited || retried) && mode === 'resume' && target
          ? { kind: 'restarting', mode, sessionId: target }
          : { kind: 'restarting', mode }
      )
    },
    [paneKey, agent, sessionId, transcriptPath, exited, phase]
  )
  useEffect(() => {
    if (phase.kind !== 'restarting') {
      return
    }
    const settle = setTimeout(
      () =>
        setPhase({
          kind: 'failed',
          mode: phase.mode,
          reason: 'failed',
          ...(phase.sessionId ? { sessionId: phase.sessionId } : {})
        }),
      AGENT_RESTART_SETTLE_MS
    )
    return () => clearTimeout(settle)
  }, [phase])
  return useMemo(() => ({ phase, canResume, restart }), [phase, canResume, restart])
}
