import { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '../../store'
import {
  nativeChatStartupPhaseNoticeWithBody,
  type NativeChatStartupNotice
} from '../../../../shared/native-chat-startup-notice'
import { useNativeChatStartupNotice } from './use-native-chat-startup-notice'

// Why this specific reason only: `codex-update-prompt` is the CLI's own "Update available!"
// menu, the one dialog that actually runs `npm install -g @openai/codex` and needs a
// restart. `codex-model-migration-prompt` ("Codex just got an upgrade…") looks similar but
// is a one-time default-model notice — dismissing it never spawns an update or exits Codex,
// so it must never arm a restart hold.
const UPDATE_PROMPT_REASON = 'codex-update-prompt'
// Case-insensitive substring match against the real "1. Update now" / "2. Skip" menu — the
// only signal available, since the option's PTY-send digit carries no semantic meaning.
const UPDATE_ACCEPT_LABEL_RE = /update/i

// Generous on purpose: npm installs can be slow (disk contention, a cold registry cache,
// the Windows EPERM/unlink-retry path seen in the reported capture), and the hold only
// needs to outlive the single window between "user clicked Update now" and "the respawned
// Codex reaches its own ready prompt, resetting the watch." A hold that's too short just
// reproduces the original bug (kicked out of chat mid-restart); too long costs nothing,
// since it is scoped to one ptyId and is never consulted again once that pty is gone.
const RESTART_HOLD_MS = 5 * 60 * 1000

export type NativeChatStartupRestart = {
  /** The notice to render — same as the input while nothing is auto-restarting, swapped to
   *  a `restarting` phase (carrying the same log tail) once an authorized restart queues. */
  notice: NativeChatStartupNotice | null
  /** Wraps the raw PTY send: recognizes "the update was just authorized" before forwarding. */
  onChoose: (send: string) => void
  /** Present only on `restart-required` / `update-failed` when nothing is already queued —
   *  lets the user restart an update they ran by hand in the raw terminal. */
  onRestart: (() => void) | undefined
}

/**
 * Owns the whole startup-takeover surface for one chat pane: watches the terminal via
 * `useNativeChatStartupNotice`, then layers the one stateful decision notice-reading alone
 * cannot make on top — was this specific update authorized by the user through this card?
 * On `restart-required`, if it was, the restart is queued automatically through the
 * existing Codex account-switch restart machinery (`queueCodexPaneRestarts` →
 * `TerminalPane.tsx`'s `handleRestartCodexPane`, unchanged) and the tab's chat mode is held
 * across the agent's exit. An update run by hand in the raw terminal is left alone — only a
 * manual "Restart Codex" button is offered. The single hook call keeps the composition
 * detail out of the view component; see use-native-chat-startup-notice.ts for the reader.
 */
export function useNativeChatStartupRestart(args: {
  paneKey: string
  targetPtyId: string | null
  readTerminalScreen?: () => string | null
  isVisible: boolean
  messageCount: number
  onHoldChatForAgentRestart?: (ptyId: string, holdMs: number) => void
  sendRaw: (raw: string) => void
}): NativeChatStartupRestart {
  const { targetPtyId, onHoldChatForAgentRestart, sendRaw } = args
  const startupNotice = useNativeChatStartupNotice({
    paneKey: args.paneKey,
    targetPtyId,
    readTerminalScreen: args.readTerminalScreen,
    isVisible: args.isVisible,
    messageCount: args.messageCount
  })
  // The ptyId this hook has seen the user authorize an update for, so a later
  // restart-required observation on the SAME pty knows to auto-restart. A pty swap
  // (relaunch, split rebind) invalidates it — never let an old authorization silently
  // auto-restart an unrelated later session. A ref write during render (not an effect) is
  // fine here: it is idempotent under StrictMode's double-render and nothing reads it until
  // after this render commits.
  const authorizedPtyIdRef = useRef<string | null>(null)
  if (targetPtyId !== authorizedPtyIdRef.current) {
    authorizedPtyIdRef.current = null
  }
  // Guards the actual restart-queueing side effect against firing twice for the same ptyId
  // (repeated restart-required polls, or an auto-restart racing a manual click).
  const queuedPtyIdRef = useRef<string | null>(null)

  const queueRestartWithHold = useCallback(
    (ptyId: string) => {
      queuedPtyIdRef.current = ptyId
      onHoldChatForAgentRestart?.(ptyId, RESTART_HOLD_MS)
      useAppStore.getState().queueCodexPaneRestarts([ptyId])
    },
    [onHoldChatForAgentRestart]
  )

  const onChoose = useCallback(
    (send: string) => {
      if (
        targetPtyId &&
        startupNotice?.phase === 'prompt' &&
        startupNotice.reason === UPDATE_PROMPT_REASON
      ) {
        const chosen = startupNotice.options.find((option) => option.send === send)
        if (chosen && UPDATE_ACCEPT_LABEL_RE.test(chosen.label)) {
          authorizedPtyIdRef.current = targetPtyId
          onHoldChatForAgentRestart?.(targetPtyId, RESTART_HOLD_MS)
        }
      }
      sendRaw(send)
    },
    [targetPtyId, startupNotice, onHoldChatForAgentRestart, sendRaw]
  )

  const onManualRestart = useCallback(() => {
    if (targetPtyId && queuedPtyIdRef.current !== targetPtyId) {
      queueRestartWithHold(targetPtyId)
    }
  }, [targetPtyId, queueRestartWithHold])

  const authorized = targetPtyId !== null && authorizedPtyIdRef.current === targetPtyId
  const shouldAutoRestart = Boolean(
    targetPtyId && startupNotice?.phase === 'restart-required' && authorized
  )

  // The actual store write is a side effect and belongs in an effect, not render — the
  // `notice` override below still switches to `restarting` in this same render, so the UI
  // is instant even though queueing itself lands a tick later.
  useEffect(() => {
    if (shouldAutoRestart && targetPtyId && queuedPtyIdRef.current !== targetPtyId) {
      queueRestartWithHold(targetPtyId)
    }
  }, [shouldAutoRestart, targetPtyId, queueRestartWithHold])

  if (shouldAutoRestart && startupNotice) {
    return {
      notice: nativeChatStartupPhaseNoticeWithBody('restarting', startupNotice.body),
      onChoose,
      onRestart: undefined
    }
  }
  const showManualRestart =
    startupNotice?.phase === 'restart-required' || startupNotice?.phase === 'update-failed'
  return {
    notice: startupNotice,
    onChoose,
    onRestart: showManualRestart ? onManualRestart : undefined
  }
}
