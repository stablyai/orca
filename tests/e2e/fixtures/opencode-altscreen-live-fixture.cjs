// OpenCode/OpenTUI-shaped ALT-SCREEN TUI: a full-screen frame repainted every
// tick inside synchronized-output brackets, with a wide glyph inventory (box
// drawing, emoji, CJK) so each repaint exercises the shared WebGL glyph atlas.
//
// Why a second TUI fixture: codex-inline-live-block-fixture.cjs models the
// INLINE shape (normal buffer, live block glued to the bottom). OpenCode runs
// full-screen on the alternate buffer and repaints absolutely-positioned rows,
// which is the shape that leaves stale/garbled pixels after a hidden stretch —
// nothing scrolls, so no row ever self-heals through the scroll path.
//
// argv[2] = heartbeat file path (latest frame number, rewritten every tick)
// argv[3] = ticks per second (default 16)
// The stream never stops on its own; tests hide/park/reveal around it.
const fs = require('node:fs')

const heartbeatPath = process.argv[2]
const TICKS_PER_SECOND = Math.max(1, Number(process.argv[3]) || 16)
const TICK_MS = Math.max(1, Math.round(1000 / TICKS_PER_SECOND))

// Why a rotating inventory: a single repeated glyph set stays resident in the
// atlas after one rasterization. Rotating forces fresh glyph uploads on most
// frames, which is what grows atlas pages and drives the page-merge path.
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const BADGES = ['🟢', '🟡', '🔵', '🟣', '🟠']
const CJK = ['実行中', '生成中', '待機中', '完了', '解析中']

let frame = 0

function rows() {
  return process.stdout.rows || 24
}

function cols() {
  return process.stdout.columns || 80
}

function bodyRow(index) {
  const spin = SPINNER[(frame + index) % SPINNER.length]
  const badge = BADGES[(frame + index) % BADGES.length]
  const cjk = CJK[(frame + index) % CJK.length]
  const bar = '█'.repeat((frame + index) % 12).padEnd(12, '░')
  return (
    `│ ${spin} ${badge} row ${String(index).padStart(3, '0')} ${cjk} ${bar} ` +
    `tok ${String((frame * 7 + index) % 100000).padStart(6, '0')} λ∑√≈∂ `
  )
}

// A full-screen absolute repaint: home, then one absolutely-positioned write
// per row. No scrolling, so a row that paints wrong stays wrong.
function fullFrame() {
  const width = Math.max(20, Math.min(cols() - 2, 100))
  const height = rows()
  const lines = [
    `╭─ OPENCODE_FRAME_${String(frame).padStart(6, '0')} ${'─'.repeat(Math.max(0, width - 30))}╮`
  ]
  for (let index = 0; index < Math.max(0, height - 3); index += 1) {
    lines.push(`${bodyRow(index).slice(0, width).padEnd(width, ' ')}│`)
  }
  lines.push(
    `╰─ status: streaming · OPENCODE_TAIL_${String(frame).padStart(6, '0')} ${'─'.repeat(Math.max(0, width - 46))}╯`
  )
  let out = ''
  for (const [index, line] of lines.entries()) {
    out += `\x1b[${index + 1};1H\x1b[K${line}`
  }
  return out
}

function tick() {
  frame += 1
  // Synchronized output around every repaint, exactly like OpenTUI.
  process.stdout.write(`\x1b[?2026h\x1b[?25l${fullFrame()}\x1b[?25h\x1b[?2026l`)
  if (heartbeatPath) {
    try {
      // Why write-then-rename: writeFileSync truncates before writing, so a
      // concurrent reader can see '' and read it as frame 0.
      fs.writeFileSync(`${heartbeatPath}.tmp`, String(frame))
      fs.renameSync(`${heartbeatPath}.tmp`, heartbeatPath)
    } catch {
      // heartbeat is best-effort; the stream itself is the product
    }
  }
}

// OpenCode-shaped startup: capability queries, alt screen, mouse reporting.
process.stdout.write('\x1b[c\x1b[6n\x1b]10;?\x07\x1b]11;?\x07')
process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H')
process.stdout.write('\x1b[?1002h\x1b[?1006h')

let tickTimer = setInterval(tick, TICK_MS)
let frozen = false

// Freeze: stop producing new frames but STAY on the alt screen holding the last
// painted frame. Tests need this to compare pixels — a live stream would differ
// between two shots for legitimate reasons, and quitting would leave a shell
// prompt. A frozen fixture also stops answering SIGWINCH, so only Orca's own
// render path can repair the display, which is what's under test.
//
// `midFrame` models the STA-2694 hazard directly: the TUI opens a synchronized
// frame (`?2026h`), paints it, and is interrupted before writing the closing
// `?2026l`. That is what a hide lands on many times a second in the field, and
// it leaves xterm's synchronizedOutput mode latched — which makes every reveal
// repaint a no-op until something clears it.
function freeze(options) {
  if (frozen) {
    return
  }
  frozen = true
  clearInterval(tickTimer)
  tickTimer = null
  if (options && options.midFrame) {
    process.stdout.write(`\x1b[?2026h\x1b[?25l${fullFrame()}`)
  }
}

// A real TUI repaints on SIGWINCH. Keep that for realism while live — tests must
// converge WITHOUT relying on it, since needing a resize IS the bug under test.
process.stdout.on('resize', () => {
  if (frozen) {
    return
  }
  process.stdout.write(`\x1b[?2026h\x1b[?25l${fullFrame()}\x1b[?25h\x1b[?2026l`)
})
process.stdin.resume()
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
}

let stopping = false
function stop() {
  if (stopping) {
    return
  }
  stopping = true
  if (tickTimer) {
    clearInterval(tickTimer)
  }
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false)
  }
  // Why: the e2e sends Ctrl+C while raw mode is active, so Node receives a byte
  // instead of SIGINT; explicitly restore modes and terminate the fixture.
  process.stdout.write('\x1b[?1002l\x1b[?1006l\x1b[?25h\x1b[?2026l\x1b[?1049l', () =>
    process.exit(0)
  )
}
// Why a multi-byte sentinel and not a single key: at startup this fixture emits
// DA1/CPR/OSC-10/OSC-11 queries, and the terminal's replies arrive on stdin —
// an OSC color reply ("rgb:ffff/...") contains 'f', so a single-letter trigger
// froze the fixture against its own startup handshake before frame 1.
const FREEZE_SENTINEL = 'ORCA_FREEZE_NOW'
const FREEZE_MID_FRAME_SENTINEL = 'ORCA_FREEZE_MID_FRAME'
const MAX_SENTINEL_LEN = Math.max(FREEZE_SENTINEL.length, FREEZE_MID_FRAME_SENTINEL.length)
let stdinTail = ''
process.stdin.on('data', (chunk) => {
  if (chunk.includes(0x03)) {
    stop()
    return
  }
  stdinTail = `${stdinTail}${chunk.toString('latin1')}`.slice(-2 * MAX_SENTINEL_LEN)
  // Why check mid-frame first: both share the 'ORCA_FREEZE_' prefix, so testing
  // the longer sentinel first keeps a partial read from picking the wrong mode.
  if (stdinTail.includes(FREEZE_MID_FRAME_SENTINEL)) {
    stdinTail = ''
    freeze({ midFrame: true })
    return
  }
  if (stdinTail.includes(FREEZE_SENTINEL)) {
    stdinTail = ''
    freeze()
  }
})
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
