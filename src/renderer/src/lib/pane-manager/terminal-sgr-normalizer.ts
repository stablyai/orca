/**
 * Dense-SGR normalization for terminal output.
 *
 * Why: a syntax-highlighted flood (every character carrying its own SGR span)
 * parses ~50x slower than plain text in xterm, and that synchronous parse
 * runs on the renderer's main thread — the shared FIFO then parks keystroke
 * echo behind the flood. Removing redundant SGR bytes before the write cuts
 * the parse load without changing the rendered result.
 *
 * Rules (semantics-preserving):
 *  1. Identical adjacent SGR sequences collapse to one
 *     (`\x1b[31m\x1b[31m` -> `\x1b[31m`).
 *  2. A reset (`\x1b[0m`/`\x1b[m`) immediately followed by an SGR that
 *     re-specifies every non-default attribute of the pre-reset state is
 *     dropped (`\x1b[31mx\x1b[0m\x1b[32m` -> `\x1b[31mx\x1b[32m`). This is the
 *     dominant pattern of character-level syntax highlighting.
 *
 * Everything else — non-SGR CSI, OSC, DCS, strings, plain text — passes
 * through byte-identical. The normalizer is a strict state machine: any
 * sequence it cannot prove safe to drop is emitted unchanged.
 */
export type SgrColor = { kind: 'default' | 'index' | 'rgb'; value: string } | null

type SimpleSgrState = {
  fg: SgrColor
  bg: SgrColor
  hasAttrs: boolean
}

const EMPTY_STATE: SimpleSgrState = { fg: null, bg: null, hasAttrs: false }

function parseSgrParams(params: string): SimpleSgrState | null {
  if (params === '') {
    return { ...EMPTY_STATE }
  }
  const parts = params.split(';')
  const state: SimpleSgrState = { fg: null, bg: null, hasAttrs: false }
  let index = 0
  while (index < parts.length) {
    const code = parts[index] === '' ? 0 : Number(parts[index])
    if (Number.isNaN(code)) {
      return null
    }
    if (code === 0) {
      // Why: `\x1b[0;1m` resets AND sets attributes; keep parsing so the
      // reported state reflects what the sequence actually sets.
      index += 1
      continue
    }
    if (
      code === 1 || code === 2 || code === 3 || code === 4 || code === 5 || code === 6 ||
      code === 7 || code === 8 || code === 9 || code === 21 || code === 53
    ) {
      state.hasAttrs = true
    } else if (code === 22 || code === 23 || code === 24 || code === 25 || code === 27 ||
      code === 28 || code === 29 || code === 55) {
      // Attribute clears alone don't make a reset-collapse unsafe.
    } else if (code >= 30 && code <= 37) {
      state.fg = { kind: 'index', value: String(code - 30) }
    } else if (code === 38) {
      const color = parseColorParam(parts, index)
      if (!color) {
        return null
      }
      state.fg = color
      index = color.consumed
    } else if (code === 39) {
      state.fg = { kind: 'default', value: '39' }
    } else if (code >= 40 && code <= 47) {
      state.bg = { kind: 'index', value: String(code - 40) }
    } else if (code === 48) {
      const color = parseColorParam(parts, index)
      if (!color) {
        return null
      }
      state.bg = color
      index = color.consumed
    } else if (code === 49) {
      state.bg = { kind: 'default', value: '49' }
    } else if (code >= 90 && code <= 97) {
      state.fg = { kind: 'index', value: String(code - 90 + 8) }
    } else if (code >= 100 && code <= 107) {
      state.bg = { kind: 'index', value: String(code - 100 + 8) }
    } else {
      // Unknown parameter: mark dirty so no reset-collapse is attempted.
      state.hasAttrs = true
    }
    index += 1
  }
  return state
}

function parseColorParam(
  parts: string[],
  startIndex: number
): { kind: 'index' | 'rgb'; value: string; consumed: number } | null {
  const mode = parts[startIndex + 1]
  if (mode === '5' && parts[startIndex + 2] !== undefined) {
    const value = parts[startIndex + 2]
    if (value === '' || Number.isNaN(Number(value))) {
      return null
    }
    return { kind: 'index', value: `5;${value}`, consumed: startIndex + 2 }
  }
  if (
    mode === '2' &&
    parts[startIndex + 2] !== undefined &&
    parts[startIndex + 3] !== undefined &&
    parts[startIndex + 4] !== undefined
  ) {
    const r = parts[startIndex + 2]
    const g = parts[startIndex + 3]
    const b = parts[startIndex + 4]
    if ([r, g, b].some((v) => v === '' || Number.isNaN(Number(v)))) {
      return null
    }
    return { kind: 'rgb', value: `2;${r};${g};${b}`, consumed: startIndex + 4 }
  }
  return null
}

/** True when `override` re-specifies every non-default attribute of `base`. */
function covers(base: SimpleSgrState, override: SimpleSgrState): boolean {
  if (base.hasAttrs) {
    return false
  }
  // A default fg/bg (39m/49m) needs no override: dropping a reset leaves the
  // default default. Only explicit colors must be re-specified.
  if (base.fg !== null && base.fg.kind !== 'default' && override.fg === null) {
    return false
  }
  if (base.bg !== null && base.bg.kind !== 'default' && override.bg === null) {
    return false
  }
  return true
}

function sameState(left: SimpleSgrState, right: SimpleSgrState): boolean {
  if (left.hasAttrs !== right.hasAttrs) {
    return false
  }
  const sameColor = (a: SgrColor, b: SgrColor): boolean =>
    a === null || b === null ? a === b : a.kind === b.kind && a.value === b.value
  return sameColor(left.fg, right.fg) && sameColor(left.bg, right.bg)
}

const ESC = '\x1b'

function isSgrReset(params: string): boolean {
  return params === '' || params === '0'
}

export function normalizeSgrDensity(data: string): string {
  if (!data.includes(ESC)) {
    return data
  }
  // Fast pre-check: only transform when at least one SGR-span pattern might be
  // present. The scan below is O(n); the win is skipping chunk-size scans of
  // ordinary logs, not gatekeeping correctness on short inputs.
  let escapes = 0
  for (let index = 0; index < data.length; index += 1) {
    if (data.charCodeAt(index) === 0x1b) {
      escapes += 1
      if (escapes > 2) {
        break
      }
    }
  }
  if (escapes < 2) {
    return data
  }

  const out: string[] = []
  // SGR bookkeeping across the stream.
  let pendingSgr: string | null = null // SGR params seen but not yet emitted
  let lastEmittedState: SimpleSgrState = { ...EMPTY_STATE }
  let lastEmittedParams: string | null = null
  let pendingResetCanDrop = false // a reset is pending and safe to drop

  const emitSgr = (params: string, state: SimpleSgrState | null): void => {
    pendingSgr = null
    if (state === null) {
      out.push(`${ESC}[${params}m`)
      lastEmittedState = { ...EMPTY_STATE }
      lastEmittedParams = params
      pendingResetCanDrop = false
      return
    }
    if (params === lastEmittedParams && !state.hasAttrs) {
      // Rule 1: identical adjacent sequence — drop this one, keep state.
      return
    }
    out.push(`${ESC}[${params}m`)
    // Accumulate: a later SGR overrides the attributes it specifies and keeps
    // the rest (bold persists across a bare fg change, etc.).
    if (isSgrReset(params)) {
      lastEmittedState = { ...EMPTY_STATE }
    } else {
      const merged = { ...lastEmittedState }
      if (state.fg !== null) {
        merged.fg = state.fg
      }
      if (state.bg !== null) {
        merged.bg = state.bg
      }
      if (state.hasAttrs) {
        merged.hasAttrs = true
      }
      lastEmittedState = merged
    }
    lastEmittedParams = params
    pendingResetCanDrop = false
  }

  const flushPendingSgr = (): void => {
    if (pendingSgr === null) {
      return
    }
    const params = pendingSgr
    const parsed = parseSgrParams(params)
    if (parsed === null) {
      emitSgr(params, null)
      return
    }
    emitSgr(params, parsed)
  }

  let index = 0
  const length = data.length
  while (index < length) {
    const char = data[index]
    if (char !== ESC) {
      // Plain text run: any pending SGR must be emitted before the text.
      flushPendingSgr()
      pendingResetCanDrop = false
      const start = index
      while (index < length && data[index] !== ESC) {
        index += 1
      }
      out.push(data.slice(start, index))
      continue
    }
    const next = data[index + 1]
    if (next === '[') {
      // CSI: scan to the final byte.
      let cursor = index + 2
      while (cursor < length) {
        const byte = data[cursor]
        if (byte >= '@' && byte <= '~') {
          break
        }
        cursor += 1
      }
      if (cursor >= length) {
        flushPendingSgr()
        out.push(data.slice(index))
        break
      }
      const params = data.slice(index + 2, cursor)
      const isSgr = data[cursor] === 'm'
      if (!isSgr) {
        flushPendingSgr()
        pendingResetCanDrop = false
        out.push(data.slice(index, cursor + 1))
        index = cursor + 1
        continue
      }
      // SGR sequence.
      const parsed = parseSgrParams(params)
      if (parsed === null) {
        flushPendingSgr()
        pendingResetCanDrop = false
        out.push(data.slice(index, cursor + 1))
        index = cursor + 1
        continue
      }
      if (isSgrReset(params)) {
        // A reset: defer the decision — if the very next thing is an SGR that
        // covers the pre-reset state, this reset is redundant and dropped.
        if (pendingSgr !== null && !isSgrReset(pendingSgr)) {
          emitSgr(pendingSgr, parseSgrParams(pendingSgr))
        }
        if (pendingSgr === null) {
          pendingSgr = params
          // Optimistically droppable: the following SGR (if any) decides via
          // covers(preResetState, nextState) — the reset itself always wins
          // when followed by text (flushPendingSgr emits it).
          pendingResetCanDrop = true
        }
        // A pending reset already exists (consecutive resets): keep the first.
        index = cursor + 1
        continue
      }
      if (pendingSgr !== null) {
        if (isSgrReset(pendingSgr)) {
          // Reset followed by an SGR: drop the reset iff the SGR re-specifies
          // every non-default attribute of the pre-reset state.
          const preResetState = lastEmittedState
          const dropReset = pendingResetCanDrop && covers(preResetState, parsed)
          pendingSgr = null
          if (dropReset) {
            emitSgr(params, parsed)
          } else {
            out.push(`${ESC}[0m`)
            emitSgr(params, parsed)
          }
        } else {
          // A plain SGR follows a pending plain SGR: emit the pending one.
          emitSgr(pendingSgr, parseSgrParams(pendingSgr))
          pendingSgr = params
        }
        index = cursor + 1
        continue
      }
      pendingSgr = params
      index = cursor + 1
      continue
    }
    // ESC + non-CSI.
    flushPendingSgr()
    pendingResetCanDrop = false
    const isStringSequence = next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_'
    if (isStringSequence) {
      const st = data.indexOf(`${ESC}\\`, index + 2)
      const bel = data.indexOf('\x07', index + 2)
      let end = -1
      if (st !== -1 && (bel === -1 || st < bel)) {
        end = st + 2
      } else if (bel !== -1) {
        end = bel + 1
      }
      if (end === -1) {
        out.push(data.slice(index))
        break
      }
      out.push(data.slice(index, end))
      index = end
      // Why: a string sequence does not change SGR state; only break the
      // adjacent-merge rule so a later SGR is not deduped against the one
      // emitted before the string.
      lastEmittedParams = null
      continue
    }
    out.push(data.slice(index, index + 2))
    index += 2
  }
  if (pendingSgr !== null) {
    // Trailing SGR with no text after it: emit it (unless it is a bare reset
    // that only resets to the already-clean state).
    const parsed = parseSgrParams(pendingSgr)
    if (parsed !== null && isSgrReset(pendingSgr) && sameState(lastEmittedState, EMPTY_STATE)) {
      // Bare trailing reset on an already-default state: safe to drop.
    } else {
      out.push(`${ESC}[${pendingSgr}m`)
    }
  }
  return out.join('')
}
