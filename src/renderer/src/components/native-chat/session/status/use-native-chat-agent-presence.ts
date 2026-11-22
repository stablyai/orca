import { useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../../../store/index'
import {
  NATIVE_CHAT_AGENT_PRESENT,
  nextNativeChatAgentPresence,
  type NativeChatAgentPresence
} from '../../../../../../shared/native-chat/agent-presence/native-chat-agent-presence'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatComposerNotice } from '../../composer/controls/native-chat-composer-notice'
import { nativeChatAgentPresenceNotices } from './native-chat-agent-presence-notices'
import { useTranslate } from '@/i18n/use-translate'
import { useNativeChatAgentRestart } from './use-native-chat-agent-restart'

/** An exited agent pauses sending and working state; the notices say why and what changed. */
export function useNativeChatAgentPresenceStatus(args: {
  paneKey: string
  agent: AgentType
  sessionId: string | null
  transcriptPath: string | null
  onShowTerminal?: () => void
}): { exited: boolean; notices: readonly NativeChatComposerNotice[] } {
  const { paneKey, agent, sessionId, transcriptPath, onShowTerminal } = args
  const { presence, dismissRestart } = useNativeChatAgentPresence(paneKey, sessionId)
  const t = useTranslate()
  const resumeSessionId = presence.exit?.sessionId ?? presence.restartFrom?.sessionId ?? sessionId
  const restart = useNativeChatAgentRestart({
    paneKey,
    agent,
    sessionId: resumeSessionId,
    // The chat's own transcript names only the session it shows.
    transcriptPath: resumeSessionId === sessionId ? transcriptPath : null,
    exited: presence.exit !== null,
    onRestartedRunning: dismissRestart
  })
  const notices = useMemo(
    () =>
      nativeChatAgentPresenceNotices({
        presence,
        agent,
        sessionId,
        onShowTerminal,
        onDismissRestart: dismissRestart,
        restart,
        t
      }),
    [presence, agent, sessionId, onShowTerminal, dismissRestart, restart, t]
  )
  return { exited: presence.exit !== null, notices }
}

/** Whether the pane's agent still runs, from the pane's process-grade shell-foreground evidence. */
function useNativeChatAgentPresence(
  paneKey: string,
  sessionId: string | null
): { presence: NativeChatAgentPresence; dismissRestart: () => void } {
  const foreground = useAppStore(
    useShallow((state) => {
      const entry = state.paneForegroundAgentByPaneKey[paneKey]
      return {
        gone: entry?.shellForeground === true,
        agent: entry?.agent != null,
        exitCode: entry?.exitCode ?? null
      }
    })
  )
  // `updatedAt` is stamped on this machine's receipt, so it orders against the local exit clock.
  const workingSince = useAppStore((state) => {
    const entry = state.agentStatusByPaneKey.get(paneKey)
    return entry?.state === 'working' ? entry.updatedAt : null
  })
  const [presence, setPresence] = useState<NativeChatAgentPresence>(NATIVE_CHAT_AGENT_PRESENT)
  const { gone, agent, exitCode } = foreground
  // Why an effect: stamping the exit reads the clock, which render must not.
  useEffect(() => {
    setPresence((current) =>
      nextNativeChatAgentPresence(current, {
        agentGone: gone,
        agentRunning:
          agent ||
          (current.exit !== null && workingSince !== null && workingSince > current.exit.at),
        exitCode,
        sessionId,
        now: Date.now()
      })
    )
  }, [gone, agent, exitCode, workingSince, sessionId])
  const dismissRestart = useCallback(
    () =>
      setPresence((current) => (current.restartFrom ? { ...current, restartFrom: null } : current)),
    []
  )
  return { presence, dismissRestart }
}
