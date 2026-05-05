// OSC 52 — "Manipulate Selection Data". xterm.js does not implement this
// handler itself; applications register it to let TUIs (tmux, neovim, fzf,
// ripgrep) copy to the host clipboard over SSH or through the PTY.
//
// Wire format (xterm.js strips the leading `\x1b]52;` and trailing BEL/ST
// before handing us the payload string):
//
//     Pc ; Pd
//
// Pc is one or more selection-kind letters ("c"=clipboard, "p"=primary,
// "q"=secondary, "s"=select); Pd is base64-encoded UTF-8. If Pd is "?" the
// TUI is *querying* the clipboard — we deliberately ignore that case to
// avoid leaking clipboard contents to any process writing to the PTY.
//
// Safety: OSC 52 is a classic data-exfil / overwrite vector — piping an
// attacker-controlled log into the terminal could silently replace the
// user's clipboard. Callers must gate on the user-opt-in setting
// `terminalAllowOsc52Clipboard` before invoking the handler.

export type Osc52ParseResult =
  | { kind: 'write'; selections: string; text: string }
  | { kind: 'query' }
  | { kind: 'invalid'; reason: string }

const MAX_OSC52_BYTES = 128 * 1024

export function parseOsc52(data: string): Osc52ParseResult {
  const semi = data.indexOf(';')
  if (semi === -1) {
    return { kind: 'invalid', reason: 'missing selection/data separator' }
  }
  const selections = data.slice(0, semi)
  const payload = data.slice(semi + 1)

  // Why reject empty selections: the spec allows it (defaults to "s0"), but
  // every TUI we care about emits at least one letter, and treating empty
  // as "apply to clipboard" would let malformed payloads mutate the
  // clipboard by accident.
  if (selections.length === 0) {
    return { kind: 'invalid', reason: 'empty selection list' }
  }
  if (!/^[cpqs0-7]+$/.test(selections)) {
    return { kind: 'invalid', reason: 'unknown selection kind' }
  }

  if (payload === '?') {
    return { kind: 'query' }
  }

  // Why guard size: xterm's own parser caps OSC payloads at ~10 MB; we cap
  // tighter because a legitimate clipboard write is rarely more than a
  // screenful and any multi-MB payload is almost certainly a bug or abuse.
  if (payload.length > MAX_OSC52_BYTES) {
    return { kind: 'invalid', reason: 'payload exceeds size limit' }
  }

  const decoded = decodeBase64Utf8(payload)
  if (decoded === null) {
    return { kind: 'invalid', reason: 'payload is not valid base64' }
  }
  return { kind: 'write', selections, text: decoded }
}

function decodeBase64Utf8(b64: string): string | null {
  // Why tolerate whitespace: some TUIs line-wrap the base64 payload. The
  // WHATWG `atob` rejects whitespace, so strip it first. Reject anything
  // else that doesn't match the base64 alphabet so we don't silently
  // accept garbage.
  const stripped = b64.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/=]*$/.test(stripped)) {
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
