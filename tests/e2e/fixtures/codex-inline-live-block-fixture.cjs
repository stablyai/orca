// Codex-like INLINE-mode TUI (normal buffer, never alt-screen): history lines
// scroll into terminal scrollback while a live block (working spinner + input
// box + status line) repaints glued to the bottom of the screen, wrapped in
// synchronized-output brackets. This is the write shape a real Codex CLI
// produces mid-generation — the shape the alt-screen fixtures cannot cover.
//
// argv[2] = heartbeat file path (latest frame number, rewritten every tick).
// argv[3] = history lines per second (default 4) — raise it so a hidden/parked
//           window accumulates a field-sized backlog for the reveal to race.
// The stream NEVER stops on its own; tests park/hide/reveal around it and
// assert the revealed terminal converges to the live frame without a resize.
const fs = require('node:fs')

const heartbeatPath = process.argv[2]
const TICK_MS = 60
const HISTORY_LINES_PER_SECOND = Math.max(0, Number(process.argv[3]) || 4)
const BLOCK_ROWS = 6
// argv[4]: seed scrollback size — a field Codex session carries thousands of
// lines, which is what makes the reveal replay long enough to lose races.
const INITIAL_HISTORY_LINES = Math.max(0, Number(process.argv[4]) || 120)

let frame = 0
let hist = 0

function rows() {
  return process.stdout.rows || 24
}

function cols() {
  return process.stdout.columns || 80
}

function historyLine() {
  hist += 1
  return `HIST_${String(hist).padStart(6, '0')} tool call output ${'-'.repeat(24)}`
}

function liveBlock() {
  const width = Math.max(20, Math.min(cols() - 2, 76))
  const bar = '─'.repeat(width)
  const pad = (text) => `${`│ ${text}`.padEnd(width + 1, ' ')}│`
  const top = Math.max(1, rows() - BLOCK_ROWS + 1)
  const lines = [
    `╭${bar}╮`,
    pad(`CODEX_FRAME_${String(frame).padStart(6, '0')} working${'.'.repeat(frame % 4).padEnd(3)}`),
    pad(`tokens ${frame * 17} · ${frame % 2 === 0 ? 'thinking' : 'streaming'}`),
    `╰${bar}╯`,
    '› INPUT_BOX_READY_MARKER',
    'status: streaming · esc to interrupt'
  ]
  // Absolute-position to the block top and clear below, like ratatui's inline
  // viewport redraw.
  return `\x1b[${top};1H\x1b[J${lines.join('\r\n')}`
}

// ratatui insert_before-style history: scroll one line into scrollback from
// the bottom row, then write the new history line just above the live block.
function insertHistory(count) {
  const r = rows()
  const histTop = Math.max(1, r - BLOCK_ROWS)
  let out = ''
  for (let i = 0; i < count; i += 1) {
    out += `\x1b[${r};1H\n\x1b[${histTop};1H${historyLine()}`
  }
  return out
}

let historyCarry = 0

function tick() {
  frame += 1
  historyCarry += (HISTORY_LINES_PER_SECOND * TICK_MS) / 1000
  const historyThisTick = Math.floor(historyCarry)
  historyCarry -= historyThisTick
  let out = '\x1b[?2026h\x1b[?25l'
  if (historyThisTick > 0) {
    out += insertHistory(historyThisTick)
  }
  out += liveBlock()
  out += '\x1b[?25h\x1b[?2026l'
  process.stdout.write(out)
  if (heartbeatPath) {
    try {
      fs.writeFileSync(heartbeatPath, String(frame))
    } catch {
      // heartbeat is best-effort; the stream itself is the product
    }
  }
}

// Codex-shaped startup: terminal queries (answered by xterm or the daemon's
// model responder) and mouse reporting, so the run takes the live-agent
// classification branches instead of the plain-shell ones.
process.stdout.write('\x1b[c\x1b[6n\x1b]10;?\x07\x1b]11;?\x07')
process.stdout.write('\x1b[?1002h\x1b[?1006h')

// Seed scrollback before any park so the reveal replays real history.
{
  const seed = []
  for (let i = 0; i < INITIAL_HISTORY_LINES; i += 1) {
    seed.push(historyLine())
  }
  process.stdout.write(`${seed.join('\r\n')}\r\n`)
}

const tickTimer = setInterval(tick, TICK_MS)
// A real inline TUI fully repaints its live block on SIGWINCH. Keep that
// behavior for realism, but tests must converge WITHOUT relying on it.
process.stdout.on('resize', () => {
  process.stdout.write(`\x1b[?2026h\x1b[?25l${liveBlock()}\x1b[?25h\x1b[?2026l`)
})
// Swallow query replies / mouse reports / keys like a real TUI agent.
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
  clearInterval(tickTimer)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false)
  }
  // Why: the e2e sends Ctrl+C while raw mode is active, so Node receives a
  // byte instead of SIGINT; explicitly restore modes and terminate the fixture.
  process.stdout.write('\x1b[?1002l\x1b[?1006l\x1b[?25h\x1b[?2026l', () => process.exit(0))
}

process.stdin.on('data', (data) => {
  if (Buffer.from(data).includes(3)) {
    stop()
  }
})
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
