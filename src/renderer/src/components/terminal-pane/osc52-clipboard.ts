// OSC 52 — "Manipulate Selection Data". xterm.js does not implement this
// handler itself; applications register it to let TUIs (Zellij, tmux, Neovim,
// fzf, Grok) copy to the host clipboard over SSH or through the PTY.
//
// Wire format (xterm.js strips the leading `\x1b]52;` and trailing BEL/ST
// before handing us the payload string):
//
//     Pc ; Pd
//
// Pc is zero or more selection-kind letters ("c"=clipboard, "p"=primary,
// "q"=secondary, "s"=select). Every kind lands in the system clipboard and
// `selections` does not route the write — longstanding behavior this flip
// only makes reachable by default. A PRIMARY sink exists
// (writeSelectionClipboardText), so routing `p` there on Linux is an open
// question, deliberately left out of a change that is about the gate.
// Pd is base64-encoded UTF-8. If Pd is "?" the TUI is *querying* the
// clipboard — we deliberately ignore that case to avoid leaking clipboard
// contents to any process writing to the PTY.
//
// Safety: OSC 52 is a classic clipboard-overwrite vector — piping an
// attacker-controlled log into the terminal could silently replace the user's
// clipboard. Callers gate on `terminalAllowOsc52Clipboard` (default on; query
// stays blocked, so nothing is exfiltrated; payload size is capped).
//
// Accepted residual risk of default-on: the decoded text is written verbatim,
// newlines and all, so a hostile PTY can stage an execute-on-paste payload.
// We do not filter here — a multi-line copy out of a TUI is the feature — and
// the mitigation belongs at paste time, where bracketed paste keeps a pasted
// newline out of the shell's input (see terminal-bracketed-paste.ts). This
// matches kitty and Ghostty, which both allow OSC 52 writes unprompted by
// default while still gating reads.

export type Osc52ParseResult =
  /** `selections` is normalized: an empty Pc is reported as 'c'. */
  | { kind: 'write'; selections: string; text: string }
  | { kind: 'query' }
  | { kind: 'invalid'; reason: string }

export type Osc52ClipboardRequestOptions = {
  allowClipboardWrite: boolean
  writeClipboardText: (text: string) => Promise<void>
  onBlockedWrite?: () => void
  onWriteFailure?: () => void
}

const MAX_OSC52_BASE64_CHARS = 128 * 1024

function reportOsc52ClipboardWriteFailure(notify?: () => void): void {
  try {
    notify?.()
  } catch {
    // A failed notifier must not escape an already-handled clipboard failure.
  }
}

/** Resolves whether an incoming OSC 52 write may touch the clipboard, and whether a
 *  refusal is worth telling the user about. */
export function resolveOsc52ClipboardGate(input: {
  /** Null/undefined until settings hydrate. */
  settingEnabled: boolean | null | undefined
  /** True while recorded PTY bytes are being written back into this pane. */
  replaying: boolean
}): { allowClipboardWrite: boolean; shouldSurfaceBlockedWrite: boolean } {
  // Why drop during replay: reattach and cold-restore re-write recorded PTY bytes through the same
  // parser, so a stale `\e]52;c;…` would overwrite whatever the user has copied since. No fresh intent.
  //
  // Known over-suppression: the flag is read when xterm parses, not when the bytes were queued, and
  // the replay path drains queued live bytes before engaging the guard (pty-connection.ts, "drain any
  // queued background bytes BEFORE the replay paint"). A copy issued in the same tick as a reattach
  // is therefore dropped silently. Fixing it means tagging chunks at queue time; a lost copy the user
  // can repeat is the cheaper side of that trade.
  const allowClipboardWrite = !input.replaying && input.settingEnabled === true
  return {
    allowClipboardWrite,
    // Why not toast on replay or pre-hydration: the toast latches once per renderer session, and neither
    // case is a real opt-out — unhydrated settings read as blocked even though the default is on.
    shouldSurfaceBlockedWrite:
      !allowClipboardWrite &&
      !input.replaying &&
      input.settingEnabled !== null &&
      input.settingEnabled !== undefined
  }
}

/** Composes the gate with the request handler into an xterm OSC handler.
 *  Extracted so the wiring is covered too, not just the gate in isolation. */
export function createOsc52OscHandler(deps: {
  getSettingEnabled: () => boolean | null | undefined
  getReplaying: () => boolean
  writeClipboardText: (text: string) => Promise<void>
  showBlockedWriteToast: () => void
  showWriteFailedToast?: () => void
}): (data: string) => boolean {
  // Why coalesce: each sequence is only ~15 bytes, so one hostile chunk can fire a
  // million parser callbacks — each a main-process clipboard write. Only the last of
  // a microtask's worth is observable, so keep that and drop the rest. This bounds a
  // flood to roughly one write per xterm parse yield, not to one write overall.
  let pendingText: string | null = null
  let flushScheduled = false
  const writeCoalesced = (text: string): Promise<void> => {
    pendingText = text
    if (!flushScheduled) {
      flushScheduled = true
      queueMicrotask(() => {
        flushScheduled = false
        const next = pendingText
        pendingText = null
        if (next !== null) {
          // Why try/catch and not just .catch(): the write moved out of the guarded
          // parser handler into a microtask, where a sync throw (or a preload that
          // never installed writeClipboardText) would surface as an uncaught error.
          // Report the otherwise invisible host failure.
          try {
            void deps.writeClipboardText(next)?.catch(() => {
              reportOsc52ClipboardWriteFailure(deps.showWriteFailedToast)
            })
          } catch {
            reportOsc52ClipboardWriteFailure(deps.showWriteFailedToast)
          }
        }
      })
    }
    // Always resolve here: failure toast is raised in the microtask above.
    // Passing onWriteFailure to handleOsc52ClipboardRequest would be dead.
    return Promise.resolve()
  }

  return (data) => {
    const gate = resolveOsc52ClipboardGate({
      settingEnabled: deps.getSettingEnabled(),
      replaying: deps.getReplaying()
    })
    return handleOsc52ClipboardRequest(data, {
      allowClipboardWrite: gate.allowClipboardWrite,
      writeClipboardText: writeCoalesced,
      onBlockedWrite: gate.shouldSurfaceBlockedWrite ? deps.showBlockedWriteToast : undefined
    })
  }
}

export function handleOsc52ClipboardRequest(
  data: string,
  options: Osc52ClipboardRequestOptions
): boolean {
  const parsed = parseOsc52(data)
  if (parsed.kind !== 'write') {
    return true
  }

  if (!options.allowClipboardWrite) {
    options.onBlockedWrite?.()
    return true
  }

  void options.writeClipboardText(parsed.text).catch(() => {
    reportOsc52ClipboardWriteFailure(options.onWriteFailure)
  })
  return true
}

export function parseOsc52(data: string): Osc52ParseResult {
  const semi = data.indexOf(';')
  if (semi === -1) {
    return { kind: 'invalid', reason: 'missing selection/data separator' }
  }
  // Why accept empty Pc: tmux copies via `\e]52;;<base64>` (window-copy.c passes an
  // empty clip through the `Ms` capability). XTerm would read that as `s0`; we merge
  // every kind into the clipboard regardless (see header). Zellij always sends `c`/`p`.
  const selections = data.slice(0, semi) || 'c'
  const payload = data.slice(semi + 1)

  if (!/^[cpqs0-7]+$/.test(selections)) {
    return { kind: 'invalid', reason: 'unknown selection kind' }
  }

  if (payload === '?') {
    return { kind: 'query' }
  }

  // Why guard size: xterm's own parser caps OSC payloads at ~10 MB; we cap
  // tighter because a legitimate clipboard write is rarely more than a
  // screenful and any multi-MB payload is almost certainly a bug or abuse.
  if (payload.length > MAX_OSC52_BASE64_CHARS) {
    return { kind: 'invalid', reason: 'payload exceeds size limit' }
  }

  const decoded = decodeBase64Utf8(payload)
  if (decoded === null) {
    return { kind: 'invalid', reason: 'payload is not valid base64' }
  }
  // Why reject empty: this is XTerm's "clear the selection", which we decline to
  // honor — with the gate default-on, any PTY could blank the clipboard for free.
  // (A truncated sequence never lands here; xterm only calls us on parse success.)
  if (decoded === '') {
    return { kind: 'invalid', reason: 'empty payload' }
  }
  return { kind: 'write', selections, text: decoded }
}

function decodeBase64Utf8(b64: string): string | null {
  // Why tolerate whitespace: some TUIs line-wrap the base64 payload. The
  // WHATWG `atob` rejects whitespace, so strip it first. Reject anything
  // else that doesn't match the base64 alphabet so we don't silently
  // accept garbage.
  const stripped = normalizeBase64Payload(b64)
  if (stripped === null) {
    return null
  }
  try {
    const binary = atob(stripped)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return null
  }
}

function normalizeBase64Payload(value: string): string | null {
  let stripped = ''
  let sawWhitespace = false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (isWhitespaceCode(code)) {
      if (!sawWhitespace) {
        stripped = value.slice(0, index)
        sawWhitespace = true
      }
      continue
    }
    if (!isBase64Code(code)) {
      return null
    }
    if (sawWhitespace) {
      stripped += value[index]
    }
  }
  return sawWhitespace ? stripped : value
}

function isBase64Code(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 47 ||
    code === 61
  )
}

function isWhitespaceCode(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13)
}
