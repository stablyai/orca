import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../store'
import {
  isAgentStartupSettled,
  readNativeChatStartupNotice,
  type NativeChatStartupNotice
} from '../../../../shared/native-chat-startup-notice'

// Why these two cadences: 300ms keeps an active dialog's log mirror (npm output, menu
// changes) feeling live; 700ms is enough to notice a dialog appearing without polling an
// idle, already-working conversation needlessly.
const ACTIVE_POLL_INTERVAL_MS = 300
const IDLE_POLL_INTERVAL_MS = 700
// Backstop for a resumed session whose Codex header already scrolled out of the live
// viewport before this hook ever mounted — isAgentStartupSettled would never fire, so the
// watch must give up on its own rather than poll forever.
const STARTUP_WATCH_BUDGET_MS = 120_000

/**
 * Watches the live terminal viewport for a Codex startup dialog (update prompt, trust,
 * hooks-review, …) or the update flow's own running/restart-required phases, none of which
 * reach the transcript or agent-hook status — see the header comment in
 * native-chat-startup-notice.ts for why. Renderer-local and read-only: it never writes to
 * the PTY (NativeChatView wires the card's chosen option through the existing
 * useNativeChatInteractiveSend path) and does not participate in the restart flow.
 *
 * Stops polling for good once the agent reaches its own ready prompt, keyed per `ptyId` — a
 * startup dialog cannot recur without a relaunch, which changes the ptyId and resets the
 * latch. Two more backstops guard against polling forever: the watch budget above, and a
 * message arriving in the transcript after this hook mounted (proof the conversation is
 * live, even for a resumed session whose earlier messages were already present at mount —
 * that pre-existing count must not itself silence the watch, since Codex's own resume flow
 * can present a startup dialog, e.g. the "Choose working directory to resume this session"
 * prompt, before any of those messages are known to be current).
 */
export function useNativeChatStartupNotice(args: {
  paneKey: string
  targetPtyId: string | null
  readTerminalScreen?: () => string | null
  isVisible: boolean
  messageCount: number
}): NativeChatStartupNotice | null {
  const { paneKey, targetPtyId, readTerminalScreen, isVisible, messageCount } = args
  // A hook-reported interactive prompt (question/approval) is more specific and always
  // wins — NativeChatInteractiveCard already owns rendering it.
  const interactivePrompt = useAppStore(
    (s) => s.agentStatusByPaneKey[paneKey]?.interactivePrompt ?? null
  )
  const [notice, setNotice] = useState<NativeChatStartupNotice | null>(null)
  const watchedPtyIdRef = useRef<string | null>(null)
  const settledPtyIdRef = useRef<string | null>(null)
  const mountedAtRef = useRef<number | null>(null)
  const baselineMessageCountRef = useRef(0)

  // Reset per-ptyId watch state on relaunch/restart — a new ptyId means a fresh startup
  // sequence that may block again even if the previous one settled.
  if (watchedPtyIdRef.current !== targetPtyId) {
    watchedPtyIdRef.current = targetPtyId
    settledPtyIdRef.current = null
    mountedAtRef.current = null
    baselineMessageCountRef.current = messageCount
  }

  useEffect(() => {
    if (!targetPtyId || !readTerminalScreen || !isVisible) {
      return
    }
    if (settledPtyIdRef.current === targetPtyId) {
      setNotice(null)
      return
    }
    if (messageCount > baselineMessageCountRef.current) {
      settledPtyIdRef.current = targetPtyId
      setNotice(null)
      return
    }
    if (mountedAtRef.current === null) {
      mountedAtRef.current = Date.now()
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const settle = (): void => {
      settledPtyIdRef.current = targetPtyId
      setNotice(null)
    }

    const schedule = (delay: number): void => {
      if (cancelled) {
        return
      }
      timer = setTimeout(tick, delay)
    }

    function tick(): void {
      if (cancelled) {
        return
      }
      const screen = readTerminalScreen?.() ?? null
      if (screen === null) {
        schedule(IDLE_POLL_INTERVAL_MS)
        return
      }
      if (isAgentStartupSettled(screen)) {
        settle()
        return
      }
      if (
        mountedAtRef.current !== null &&
        Date.now() - mountedAtRef.current > STARTUP_WATCH_BUDGET_MS
      ) {
        settle()
        return
      }
      const next = readNativeChatStartupNotice(screen)
      setNotice(next)
      schedule(next ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS)
    }

    tick()
    return () => {
      cancelled = true
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [targetPtyId, readTerminalScreen, isVisible, messageCount])

  return interactivePrompt ? null : notice
}
