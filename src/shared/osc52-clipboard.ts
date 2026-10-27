// OSC 52 — "Manipulate Selection Data". xterm.js does not implement this
// handler itself; applications register it to let TUIs (Zellij, tmux, Neovim,
// fzf, Grok) copy to the viewing device's clipboard over SSH or through the PTY.
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
// clipboard. Desktop gates on `terminalAllowOsc52Clipboard`; mobile has no toggle
// yet and follows its default (on). Query stays blocked, so nothing is
// exfiltrated; payload size is capped.
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

export function resolveOsc52ClipboardGate(input: {
  /** Null/undefined until settings hydrate. */
  settingEnabled: boolean | null | undefined
  /** True while recorded PTY bytes are being written back into this pane. */
  replaying: boolean
}): { allowClipboardWrite: boolean; shouldSurfaceBlockedWrite: boolean } {
  // Restore parses old PTY bytes, so replayed copies must not overwrite newer clipboard contents.
  // The guard is read at parse time: queued live bytes drained during reattach may also lose a copy in that tick
  // (pty-connection.ts). Fixing this requires queue-time tags; repeatable lost copy is preferable to stale overwrite.
  const allowClipboardWrite = !input.replaying && input.settingEnabled === true
  return {
    allowClipboardWrite,
    // Replay and pre-hydration are not opt-outs; consuming the once-per-session toast would hide a later real block.
    shouldSurfaceBlockedWrite:
      !allowClipboardWrite &&
      !input.replaying &&
      input.settingEnabled !== null &&
      input.settingEnabled !== undefined
  }
}

/** Compose gate and xterm handler so tests cover their wiring too. */
export function createOsc52OscHandler(deps: {
  getSettingEnabled: () => boolean | null | undefined
  getReplaying: () => boolean
  writeClipboardText: (text: string) => Promise<void>
  showBlockedWriteToast?: () => void
  /** Receives the refused text so a web client can retry it from a fresh click. */
  showWriteFailedToast?: (text: string) => void
}): (data: string) => boolean {
  // Hostile chunks can issue millions of writes. Coalesce to the last per microtask, roughly one native write per xterm parse yield.
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
          // Microtasks run outside the parser guard; catch synchronous missing/broken bridges as well as rejected writes and surface failures.
          try {
            void deps.writeClipboardText(next)?.catch(() => {
              reportOsc52ClipboardWriteFailure(() => deps.showWriteFailedToast?.(next))
            })
          } catch {
            reportOsc52ClipboardWriteFailure(() => deps.showWriteFailedToast?.(next))
          }
        }
      })
    }
    // Resolve here; the microtask reports failures, so handleOsc52ClipboardRequest’s failure callback would be dead.
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
  // tmux’s Ms emits empty Pc; treat it as clipboard since all selections route there. Zellij sends explicit c/p.
  const selections = data.slice(0, semi) || 'c'
  const payload = data.slice(semi + 1)

  if (!/^[cpqs0-7]+$/.test(selections)) {
    return { kind: 'invalid', reason: 'unknown selection kind' }
  }

  if (payload === '?') {
    return { kind: 'query' }
  }

  // Cap below xterm’s ~10 MB: legitimate clipboard text is small; multi-MB payloads imply abuse or a bug.
  if (payload.length > MAX_OSC52_BASE64_CHARS) {
    return { kind: 'invalid', reason: 'payload exceeds size limit' }
  }

  const decoded = decodeBase64Utf8(payload)
  if (decoded === null) {
    return { kind: 'invalid', reason: 'payload is not valid base64' }
  }
  // Refuse XTerm clear-selection requests so default-on PTYs cannot blank the clipboard; xterm already excludes truncated sequences.
  if (decoded === '') {
    return { kind: 'invalid', reason: 'empty payload' }
  }
  return { kind: 'write', selections, text: decoded }
}

function decodeBase64Utf8(b64: string): string | null {
  // Permit line-wrapped base64 from TUIs, but reject other nonalphabet bytes instead of silently accepting garbage.
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
