import { useCallback, useEffect, useRef, useState } from 'react'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { AgentSessionCommandsResult } from '../../../../../../shared/agent-session/agent-session-wire'
import { startAgentSessionCommandMenuQuery } from '../../../../../../shared/agent-session/agent-session-command-menu-query'
import { getStructuredAgentSessionReadOwner } from '../../session/structured/read/structured-agent-session-read-owner'

const CHECKING_SHOWN_AFTER_MS = 150
const CHECKING_HELD_AFTER_MS = 250

async function readMenuCommands(
  target: RuntimeClientTarget,
  sessionId: string,
  started: () => void,
  finished: () => void
): Promise<AgentSessionCommandsResult> {
  started()
  try {
    return await callStructuredAgentSession<AgentSessionCommandsResult>(
      target,
      'agentSession.commands',
      { sessionId }
    )
  } finally {
    finished()
  }
}

export function useStructuredAgentSessionCommandMenu(
  target: RuntimeClientTarget,
  sessionId: string,
  enabled: boolean
) {
  const [open, setOpen] = useState(false)
  // The host answers after any rescan it started, so a slow read means the list may still grow.
  const [checking, setChecking] = useState(false)
  const query = useRef<ReturnType<typeof startAgentSessionCommandMenuQuery> | null>(null)
  useEffect(() => {
    if (!enabled || !open) {
      return
    }
    let shown: ReturnType<typeof setTimeout> | undefined
    let hidden: ReturnType<typeof setTimeout> | undefined
    let visible = false
    const show = (next: boolean): void => {
      visible = next
      setChecking(next)
    }
    const owned = startAgentSessionCommandMenuQuery(
      () =>
        readMenuCommands(
          target,
          sessionId,
          () => {
            clearTimeout(hidden)
            if (!visible) {
              // Unchanged skills answer well inside this, so the common open re-renders nothing.
              shown = setTimeout(() => show(true), CHECKING_SHOWN_AFTER_MS)
            }
          },
          () => {
            clearTimeout(shown)
            // The new list is pushed separately and lands just after this answer.
            if (visible) {
              hidden = setTimeout(() => show(false), CHECKING_HELD_AFTER_MS)
            }
          }
        ),
      () => {}
    )
    query.current = owned
    const stop = getStructuredAgentSessionReadOwner(sessionId, target).subscribeCommandsChanged(
      owned.invalidate
    )
    return () => {
      stop()
      query.current = null
      owned.dispose()
      clearTimeout(shown)
      clearTimeout(hidden)
      show(false)
    }
  }, [enabled, open, sessionId, target])
  const refresh = useCallback(() => query.current?.invalidate(), [])
  // Named as the session controller exposes them.
  return {
    setCommandsMenuOpen: setOpen,
    refreshCommands: refresh,
    commandsChecking: enabled && open && checking
  }
}
