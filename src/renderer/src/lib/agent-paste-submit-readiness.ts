import type { GlobalSettings } from '../../../shared/types'
import { subscribeToPtyData } from '@/components/terminal-pane/pty-data-sidecar-subscriptions'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { subscribeToRuntimeTerminalData } from '@/runtime/runtime-terminal-stream'

export type PastedDraftSubmitTrigger = 'tui-ready' | 'content-echo' | 'timeout'

const BRACKETED_PASTE_ENABLE = '\x1b[?2004h'
// Why: enough carryover to catch BRACKETED_PASTE_ENABLE straddling two chunks.
const RAW_CARRY_CHARS = BRACKETED_PASTE_ENABLE.length - 1
const CLEAN_BUFFER_CAP = 8192
const ECHO_NEEDLE_CHARS = 16
// Why: below this the tail is too generic (prompts like "hi") and the echo
// trigger would misfire on unrelated output; 2004h/timeout still cover it.
const ECHO_NEEDLE_MIN_CHARS = 8
const PASTE_MARKER_SENTINEL = '\uE000'
const PASTE_MARKER_LOOKBACK_CHARS = 12
const PASTE_MARKER_LOOKAHEAD_CHARS = 4

// CSI, OSC (BEL or ST terminated), and single-char escapes.
// oxlint-disable-next-line no-control-regex -- terminal escape sequences require control chars
const ANSI_SEQUENCE_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g
// Raw ESC and caret-notation echo forms of the bracketed-paste markers.
// oxlint-disable-next-line no-control-regex -- terminal escape sequences require control chars
const PASTE_MARKER_RE = /\x1b\[20[01]~|\^\[\[20[01]~/g

function stripToVisibleChars(data: string): string {
  return (
    data
      // Why: cooked-mode line discipline / ZLE echoes the paste back with its
      // markers (raw ESC or caret form). Keep a sentinel where each marker
      // stood so the echo of the paste itself is distinguishable from the
      // TUI later rendering the consumed text in its input box.
      .replace(PASTE_MARKER_RE, PASTE_MARKER_SENTINEL)
      .replace(ANSI_SEQUENCE_RE, '')
      .replace(/\s+/g, '')
  )
}

export function buildDraftEchoNeedle(content: string): string {
  const needle = stripToVisibleChars(content).slice(-ECHO_NEEDLE_CHARS)
  return needle.length >= ECHO_NEEDLE_MIN_CHARS ? needle : ''
}

function findEchoOutsidePasteMarkers(buffer: string, needle: string): boolean {
  let searchFrom = 0
  while (searchFrom <= buffer.length - needle.length) {
    const at = buffer.indexOf(needle, searchFrom)
    if (at === -1) {
      return false
    }
    const before = buffer.slice(Math.max(0, at - PASTE_MARKER_LOOKBACK_CHARS), at)
    const after = buffer.slice(
      at + needle.length,
      at + needle.length + PASTE_MARKER_LOOKAHEAD_CHARS
    )
    // Why: `200~`/`201~` fragments cover a marker that straddled two chunks
    // and escaped PASTE_MARKER_RE; treat them like the sentinel.
    const nearMarker = [before, after].some(
      (window) =>
        window.includes(PASTE_MARKER_SENTINEL) || window.includes('200~') || window.includes('201~')
    )
    if (!nearMarker) {
      return true
    }
    searchFrom = at + needle.length
  }
  return false
}

/**
 * Wait until a just-pasted draft is safe to submit with Enter.
 *
 * Why: `process-ready` agents (Hermes) paste after a PTY-quiet window that can
 * fire ~1.5s into a TUI boot that takes 15s+ (the node ui-tui). The PTY input
 * queue is FIFO, so an Enter written after the TUI signals interactivity
 * (DECSET 2004) is guaranteed to be processed after the buffered paste text —
 * a fixed post-paste delay instead submits into the booting process and the
 * Enter is swallowed, parking the prompt in the input box forever.
 *
 * Triggers, first wins:
 *  - 'tui-ready': DECSET 2004 enable seen after the paste (modern Hermes TUI).
 *  - 'content-echo': the tail of the pasted content is echoed back (legacy
 *    prompt_toolkit TUIs that never enable bracketed paste).
 *  - 'timeout': budget expired; callers submit best-effort, matching the
 *    pre-existing fixed-delay behavior.
 */
export function waitForPastedDraftSubmitReady(args: {
  ptyId: string
  content: string
  timeoutMs: number
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
}): Promise<PastedDraftSubmitTrigger> {
  const { ptyId, content, timeoutMs, settings } = args
  const needle = buildDraftEchoNeedle(content)
  return new Promise<PastedDraftSubmitTrigger>((resolve) => {
    let settled = false
    let rawCarry = ''
    let cleanBuffer = ''
    let hardTimer: number | null = null
    let unsubscribe: (() => void) | null = null

    const finish = (value: PastedDraftSubmitTrigger): void => {
      if (settled) {
        return
      }
      settled = true
      if (hardTimer !== null) {
        window.clearTimeout(hardTimer)
      }
      unsubscribe?.()
      resolve(value)
    }

    const observeData = (data: string): void => {
      if (settled) {
        return
      }
      const rawWindow = rawCarry + data
      if (rawWindow.includes(BRACKETED_PASTE_ENABLE)) {
        finish('tui-ready')
        return
      }
      rawCarry = rawWindow.slice(-RAW_CARRY_CHARS)
      if (needle.length > 0) {
        cleanBuffer = (cleanBuffer + stripToVisibleChars(data)).slice(-CLEAN_BUFFER_CAP)
        if (findEchoOutsidePasteMarkers(cleanBuffer, needle)) {
          finish('content-echo')
        }
      }
    }

    hardTimer = window.setTimeout(() => finish('timeout'), timeoutMs)

    if (isRemoteRuntimePtyId(ptyId)) {
      void subscribeToRuntimeTerminalData(
        settings,
        ptyId,
        `desktop:paste-submit-ready:${ptyId}`,
        observeData
      )
        .then((remoteUnsubscribe) => {
          if (settled) {
            remoteUnsubscribe()
            return
          }
          unsubscribe = remoteUnsubscribe
        })
        .catch(() => finish('timeout'))
      return
    }

    unsubscribe = subscribeToPtyData(ptyId, observeData)
  })
}
