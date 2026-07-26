// Seeded ANSI byte-stream generator for the terminal garble differential
// fuzz suites (headless-emulator-fidelity.fuzz.test.ts and
// hidden-reveal-reconciliation.fuzz.test.ts). The op mix models real agent
// TUI output (Claude Code / Codex): CR status-line redraws, cursor-up panel
// repaints, DEC 2026 synchronized frames, SGR color runs, wide CJK and ZWJ
// emoji, wrapped long lines, alt-screen sessions, and scroll regions.
//
// Deliberately excluded ops (they would fuzz behavior the snapshot/restore
// contract does not promise to preserve, so any diff would be noise, not a
// garble bug):
// - DECAWM (?7l) and IRM (CSI 4h): SerializeAddon does not re-emit them and
//   rehydrateSequences (headless-emulator.ts buildRehydrateSequences) only
//   covers alt-screen/bracketed-paste/app-cursor/mouse modes.
// - Terminal queries (DA/DSR/DECRQM): the emulator is write-only by contract
//   (headless-emulator.ts onQueryReply gating); replies are a separate
//   authority problem with its own pinned tests (session.test.ts).

/** Same seeded PRNG as retained-tail-redraw-window.equivalence.test.ts. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type AgentTuiStreamDims = { cols: number; rows: number }

export type AgentTuiStreamProfile = {
  /** Mouse-mode toggles require mirroring TerminalMouseModeMirror to build
   *  rehydrate parity; the renderer-side fuzz cannot import that main-only
   *  module (tsconfig.tc.web.json excludes src/main/daemon), so it opts out. */
  includeMouseModes: boolean
  /** OSC 8 hyperlinks mark their cells underlined in the xterm buffer, but
   *  SerializeAddon never re-emits OSC 8 — production restores link ranges
   *  out-of-band via snapshot.oscLinks (collectHeadlessOscLinkRanges), so
   *  byte-replay fidelity legitimately drops that underline. The suites pin
   *  the metadata compensation in a targeted test instead of fuzzing it. */
  includeOscHyperlinks: boolean
  opCount: number
}

function int(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1))
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)]!
}

const WORDS = [
  'reading',
  'src/main/daemon/session.ts',
  'tokens 12.4k',
  'esc to interrupt',
  'Thinking…',
  'bash: pnpm typecheck',
  '+142 -37',
  'PASS terminal.test.ts',
  'waiting for approval',
  'diff --git a/pty.ts'
] as const

const WIDE_RUNS = [
  '你好世界',
  '터미널 상태 확인',
  '進捗を表示中',
  '🟢 working',
  '🤖 codex',
  '✅ done ✨',
  // ZWJ emoji join — the exact width divergence the Orca unicode provider
  // exists for (shared/terminal-unicode-provider.ts).
  '👨‍👩‍👧‍👦 team',
  '🇰🇷 locale'
] as const

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'] as const

function sgr(rng: () => number): string {
  const roll = rng()
  if (roll < 0.2) {
    return `\x1b[${pick(rng, ['0', '1', '2', '3', '4', '7', '9', '22', '24', '39', '49'])}m`
  }
  if (roll < 0.55) {
    return `\x1b[${int(rng, 30, 37) + (rng() < 0.3 ? 60 : 0)}m`
  }
  if (roll < 0.8) {
    return `\x1b[38;5;${int(rng, 0, 255)}m`
  }
  return `\x1b[38;2;${int(rng, 0, 255)};${int(rng, 0, 255)};${int(rng, 0, 255)}m`
}

function textRun(rng: () => number): string {
  const parts: string[] = []
  const count = int(rng, 1, 3)
  for (let i = 0; i < count; i++) {
    parts.push(rng() < 0.25 ? pick(rng, WIDE_RUNS) : pick(rng, WORDS))
  }
  return parts.join(' ')
}

function styledLine(rng: () => number): string {
  return `${sgr(rng)}${textRun(rng)}\x1b[0m\r\n`
}

function panelRedraw(rng: () => number, dims: AgentTuiStreamDims): string {
  const height = int(rng, 1, Math.min(6, dims.rows - 2))
  const lines: string[] = [`\x1b[${height}A\r`]
  if (rng() < 0.5) {
    lines.push('\x1b[0J')
  }
  for (let i = 0; i < height; i++) {
    lines.push(`\x1b[2K${sgr(rng)}│ ${textRun(rng)}\x1b[0m\r\n`)
  }
  return lines.join('')
}

function statusLineRewrite(rng: () => number): string {
  return `\r\x1b[2K${sgr(rng)}${pick(rng, SPINNER)} ${textRun(rng)}\x1b[0m`
}

function cursorMotion(rng: () => number, dims: AgentTuiStreamDims): string {
  const roll = rng()
  if (roll < 0.4) {
    return `\x1b[${int(rng, 1, dims.rows)};${int(rng, 1, dims.cols)}H`
  }
  if (roll < 0.55) {
    return `\x1b[${int(rng, 1, dims.cols)}G`
  }
  return `\x1b[${int(rng, 1, 4)}${pick(rng, ['A', 'B', 'C', 'D'] as const)}`
}

function eraseOp(rng: () => number): string {
  return pick(rng, ['\x1b[K', '\x1b[1K', '\x1b[2K', '\x1b[0J', '\x1b[1J'] as const)
}

function wrappedLongLine(rng: () => number, dims: AgentTuiStreamDims): string {
  const unit = `${textRun(rng)} `
  const repeats = Math.ceil((dims.cols * int(rng, 1, 3)) / Math.max(unit.length, 1)) + 1
  return `${sgr(rng)}${unit.repeat(repeats)}\x1b[0m\r\n`
}

function scrollRegionBurst(rng: () => number, dims: AgentTuiStreamDims): string {
  const top = int(rng, 1, Math.max(1, dims.rows - 4))
  const bottom = int(rng, top + 1, dims.rows)
  const body: string[] = [`\x1b[${top};${bottom}r`, `\x1b[${bottom};1H`]
  for (let i = 0; i < int(rng, 1, 4); i++) {
    body.push(`${textRun(rng)}\r\n`)
  }
  body.push('\x1b[r')
  return body.join('')
}

function altScreenFrame(rng: () => number, dims: AgentTuiStreamDims): string {
  const rows = int(rng, 2, Math.min(8, dims.rows))
  const body: string[] = ['\x1b[?1049h', '\x1b[2J\x1b[H', '\x1b[?25l']
  for (let i = 0; i < rows; i++) {
    body.push(`${sgr(rng)}│ ${textRun(rng)}\x1b[0m${i === rows - 1 ? '' : '\r\n'}`)
  }
  body.push(`\x1b[${int(rng, 1, dims.rows)};${int(rng, 1, dims.cols)}H\x1b[?25h`)
  if (rng() < 0.5) {
    body.push('\x1b[?1049l')
  }
  return body.join('')
}

function synchronizedFrame(rng: () => number, dims: AgentTuiStreamDims): string {
  return `\x1b[?2026h${rng() < 0.5 ? panelRedraw(rng, dims) : statusLineRewrite(rng)}\x1b[?2026l`
}

function savedCursorDetour(rng: () => number, dims: AgentTuiStreamDims): string {
  return `\x1b7${cursorMotion(rng, dims)}${sgr(rng)}${textRun(rng)}\x1b[0m\x1b8`
}

function oscOp(rng: () => number, profile: AgentTuiStreamProfile): string {
  const roll = rng()
  if (roll < 0.5) {
    return `\x1b]0;${textRun(rng)}\x07`
  }
  if (roll < 0.8) {
    return profile.includeOscHyperlinks
      ? `\x1b]8;;https://example.com/${int(rng, 1, 999)}\x07link\x1b]8;;\x07`
      : `https://example.com/pr/${int(rng, 1, 999)}\r\n`
  }
  return '\x1b]133;A\x07'
}

function modeToggle(rng: () => number, profile: AgentTuiStreamProfile): string {
  const toggles = ['\x1b[?2004h', '\x1b[?2004l', '\x1b[?1h', '\x1b[?1l', '\x1b[?25l', '\x1b[?25h']
  if (profile.includeMouseModes) {
    toggles.push(
      '\x1b[?1000h',
      '\x1b[?1002h',
      '\x1b[?1003h',
      '\x1b[?1006h',
      '\x1b[?1000l',
      '\x1b[?1006l'
    )
  }
  return pick(rng, toggles)
}

/** One seeded agent-TUI-shaped op. Weights favor the redraw ops that have
 *  historically produced hidden-restore garble (CR rewrites, cursor-up panel
 *  repaints, DEC 2026 frames, alt-screen churn). */
function nextOp(
  rng: () => number,
  dims: AgentTuiStreamDims,
  profile: AgentTuiStreamProfile
): string {
  const roll = rng()
  if (roll < 0.18) {
    return styledLine(rng)
  }
  if (roll < 0.32) {
    return statusLineRewrite(rng)
  }
  if (roll < 0.46) {
    return panelRedraw(rng, dims)
  }
  if (roll < 0.54) {
    return synchronizedFrame(rng, dims)
  }
  if (roll < 0.62) {
    return wrappedLongLine(rng, dims)
  }
  if (roll < 0.7) {
    return cursorMotion(rng, dims) + eraseOp(rng)
  }
  if (roll < 0.76) {
    return altScreenFrame(rng, dims)
  }
  if (roll < 0.82) {
    return scrollRegionBurst(rng, dims)
  }
  if (roll < 0.88) {
    return savedCursorDetour(rng, dims)
  }
  if (roll < 0.94) {
    return oscOp(rng, profile)
  }
  return modeToggle(rng, profile)
}

export function buildAgentTuiStreamOps(
  rng: () => number,
  dims: AgentTuiStreamDims,
  profile: AgentTuiStreamProfile
): string[] {
  const ops: string[] = []
  for (let i = 0; i < profile.opCount; i++) {
    ops.push(nextOp(rng, dims, profile))
  }
  return ops
}

/** Splits a stream at random boundaries, including inside escape sequences
 *  (PTY chunking does that constantly). Never splits a surrogate pair: PTY
 *  bytes are decoded to complete code points before reaching JS strings. */
export function splitIntoRandomChunks(
  rng: () => number,
  stream: string,
  bounds: { minLen: number; maxLen: number }
): string[] {
  const chunks: string[] = []
  let cursor = 0
  while (cursor < stream.length) {
    let end = Math.min(stream.length, cursor + int(rng, bounds.minLen, bounds.maxLen))
    const boundaryCode = stream.charCodeAt(end - 1)
    if (end < stream.length && boundaryCode >= 0xd800 && boundaryCode <= 0xdbff) {
      end += 1
    }
    chunks.push(stream.slice(cursor, end))
    cursor = end
  }
  return chunks
}
