import type { TuiAgent } from '../../../shared/types'
import { TUI_AGENT_CONFIG, type DraftPasteReadySignal } from '../../../shared/tui-agent-config'
import { useAppStore } from '@/store'
import { subscribeToPtyData } from '@/components/terminal-pane/pty-dispatcher'
import { isRemoteRuntimePtyId, sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import { subscribeToRuntimeTerminalData } from '@/runtime/runtime-terminal-stream'

// Why: bracketed paste markers let modern TUIs (Claude Code / Codex / Pi /
// OpenCode / Gemini / cursor-agent / copilot) treat the inserted text as a
// single atomic paste — the payload lands in the input buffer as a draft
// instead of echoing character-by-character or triggering line-edit
// shortcuts. Intentionally omit a trailing '\r' so the draft never auto-
// submits; the user reviews and sends the prompt themselves.
const BRACKETED_PASTE_BEGIN = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'

// Why: every prefill-capable TUI we ship support for (claude / codex / pi /
// opencode / gemini / cursor-agent / copilot) emits `CSI ? 2004 h` (DECSET
// 2004 — bracketed-paste-enable) on its output stream when its input layer
// is wired up. That sequence is the protocol-level "I accept bracketed
// paste" handshake. For most agents it still does not prove the input box
// is rendered and visible. OpenCode in particular emits DECSET 2004 during
// its alt-screen setup at ~500ms, then runs a 1.3s splash render with no
// data on the PTY, then paints the actual input box at ~1.85s. Pasting
// during the silent gap drops the bytes.
//
// Default strategy: take DECSET 2004 as the necessary precondition, then
// wait for the TUI's render burst to finish — defined as
// `BRACKETED_PASTE_QUIET_MS` of stream silence after the most recent
// post-`?2004h` byte. This captures both the fast TUIs and the slow ones
// (opencode emits, sleeps, emits again, then goes quiet). Codex opts into a
// faster source-backed path: after DECSET, wait only until its composer
// prompt glyph renders.
const DECSET_BRACKETED_PASTE = '\x1b[?2004h'
const CODEX_COMPOSER_PROMPT = '›'
const BRACKETED_PASTE_QUIET_MS = 1500

// Why: deterministic signal can fail in two ways: (1) the agent never
// emits DECSET 2004 (no shipped agent does this — guarded as a fallback),
// or (2) the launch fails outright. The hard timeout caps the wait so a
// stuck launch doesn't pin a Promise forever.
const READINESS_TIMEOUT_MS = 8000

/**
 * Wait until the agent on `tabId` has rendered its input-accepting TUI,
 * then bracketed-paste `content` into its input buffer. Never appends
 * `\r`, so the draft stays editable for the user to review / append
 * before sending.
 *
 * Returns true when the paste was issued, false on timeout or missing
 * PTY. `onTimeout` lets the caller surface a UI hint (e.g. toast) when
 * the agent doesn't reach a ready state inside `timeoutMs`.
 *
 * Readiness combines DECSET 2004 with one agent-specific follow-up signal:
 *   1. `\x1b[?2004h` (DECSET 2004 — bracketed-paste-enable) on the PTY
 *      output. This is the protocol-level "I accept bracketed paste"
 *      handshake.
 *   2. Either ≥`BRACKETED_PASTE_QUIET_MS` of silence after the last byte of
 *      the post-handshake render burst, or Codex's composer prompt glyph.
 */
export async function pasteDraftWhenAgentReady(args: {
  tabId: string
  content: string
  agent?: TuiAgent
  submit?: boolean
  timeoutMs?: number
  onTimeout?: () => void
}): Promise<boolean> {
  const { tabId, content, agent, submit, timeoutMs, onTimeout } = args

  const agentConfig = agent ? TUI_AGENT_CONFIG[agent] : null

  // Why: agents with a native draft prefill mechanism (flag or env var)
  // launch with the URL already in their input box. Pasting again would
  // duplicate it. Callers should not invoke this helper for those agents;
  // the early return guards against accidental double-injection if a stale
  // call slips through.
  if (agentConfig?.draftPromptFlag || agentConfig?.draftPromptEnvVar) {
    return false
  }

  const budget = timeoutMs ?? READINESS_TIMEOUT_MS
  const readySignal = agentConfig?.draftPasteReadySignal ?? 'render-quiet-after-bracketed-paste'
  const ptyId = await waitForPtyId(tabId, budget)
  if (!ptyId) {
    onTimeout?.()
    return false
  }

  const ready = await waitForInputBoxReady(ptyId, budget, readySignal)
  if (!ready) {
    onTimeout?.()
    return false
  }

  sendRuntimePtyInput(
    useAppStore.getState().settings,
    ptyId,
    `${BRACKETED_PASTE_BEGIN}${content}${BRACKETED_PASTE_END}${submit ? '\r' : ''}`
  )
  return true
}

/**
 * Tap the PTY data stream as a side-channel observer (does NOT take over
 * the primary handler that feeds xterm) and resolve `true` once we see
 * DECSET 2004. Most agents also wait for the post-handshake render burst to
 * settle for `BRACKETED_PASTE_QUIET_MS`; Codex waits for its composer prompt
 * glyph instead. Resolves `false` on hard timeout.
 *
 * Why a sidecar subscription:
 *   - the main pane may attach mid-flight; we must not race against its
 *     handler registration on the dispatcher's primary slot.
 *   - DECSET 2004 and the Codex composer prompt may straddle two data chunks
 *     at ANSI parser boundaries, so we keep a small ring of recent bytes and
 *     search the union.
 */
function waitForInputBoxReady(
  ptyId: string,
  timeoutMs: number,
  readySignal: DraftPasteReadySignal
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    let recent = ''
    let postHandshakeRecent = ''
    let saw2004 = false
    let quietTimer: number | null = null
    let hardTimer: number | null = null
    let unsubscribe: (() => void) | null = null

    const finish = (value: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      if (hardTimer !== null) {
        window.clearTimeout(hardTimer)
      }
      if (quietTimer !== null) {
        window.clearTimeout(quietTimer)
      }
      unsubscribe?.()
      resolve(value)
    }

    const armQuietTimer = (): void => {
      if (quietTimer !== null) {
        window.clearTimeout(quietTimer)
      }
      quietTimer = window.setTimeout(() => finish(true), BRACKETED_PASTE_QUIET_MS)
    }

    const observeData = (data: string): void => {
      // Why: keep just enough recent bytes that an escape sequence split
      // across two IPC frames is still detectable. 512 bytes also covers
      // Codex's prompt render around ANSI styling without retaining a large
      // terminal scrollback copy.
      const combined = recent + data
      recent = combined.slice(-512)
      if (!saw2004) {
        const markerIndex = combined.indexOf(DECSET_BRACKETED_PASTE)
        if (markerIndex === -1) {
          return
        }
        saw2004 = true
        const postHandshakeChunk = combined.slice(markerIndex + DECSET_BRACKETED_PASTE.length)
        if (readySignal === 'codex-composer-prompt') {
          if (postHandshakeChunk.includes(CODEX_COMPOSER_PROMPT)) {
            finish(true)
            return
          }
          postHandshakeRecent = postHandshakeChunk.slice(-512)
          return
        }
        postHandshakeRecent = postHandshakeChunk.slice(-512)
      } else {
        if (
          readySignal === 'codex-composer-prompt' &&
          (data.includes(CODEX_COMPOSER_PROMPT) ||
            (postHandshakeRecent + data).includes(CODEX_COMPOSER_PROMPT))
        ) {
          finish(true)
          return
        }
        postHandshakeRecent = (postHandshakeRecent + data).slice(-512)
      }
      if (readySignal === 'codex-composer-prompt') {
        return
      }
      if (saw2004) {
        // Reset the quiet window on every byte we see post-handshake.
        // The TUI's render is "done" when the stream goes quiet for
        // BRACKETED_PASTE_QUIET_MS — at that point the input box is
        // mounted and bracketed paste lands in the input buffer.
        armQuietTimer()
      }
    }

    if (isRemoteRuntimePtyId(ptyId)) {
      void subscribeToRuntimeTerminalData(
        useAppStore.getState().settings,
        ptyId,
        `desktop:paste-ready:${ptyId}`,
        observeData
      )
        .then((remoteUnsubscribe) => {
          if (settled) {
            remoteUnsubscribe()
            return
          }
          unsubscribe = remoteUnsubscribe
        })
        .catch(() => finish(false))
    } else {
      unsubscribe = subscribeToPtyData(ptyId, observeData)
    }

    if (!settled) {
      hardTimer = window.setTimeout(() => finish(false), timeoutMs)
    }
  })
}

/**
 * Why: activation creates the tab synchronously but the PTY spawn is
 * async. Poll the store until the primary PTY id appears or the budget
 * expires. Tight interval because the wait is normally <200ms — only the
 * first launch on a cold app reaches the tail of this.
 */
async function waitForPtyId(tabId: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ptyId = useAppStore.getState().ptyIdsByTabId[tabId]?.[0]
    if (ptyId) {
      return ptyId
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50))
  }
  return null
}
