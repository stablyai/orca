// Model Codex normal-buffer redraws: append scrollback while repainting a synchronized live block at the bottom.
// argv: heartbeat path, history lines/second; keep running across park/reveal so tests can require live-frame convergence.
const fs = require('node:fs')

const heartbeatPath = process.argv[2]
const TICK_MS = 60
const HISTORY_LINES_PER_SECOND = Math.max(0, Number(process.argv[3]) || 4)
const BLOCK_ROWS = 6
// argv[4] seeds enough scrollback to expose reveal/replay races.
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
  // Match ratatui’s inline viewport redraw with absolute positioning and clear-below.
  return `\x1b[${top};1H\x1b[J${lines.join('\r\n')}`
}

// Match ratatui insert_before: scroll history from the bottom, then write above the live block.
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

// Emit agent-style queries/mouse modes so classification takes live-agent branches.
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
// Preserve realistic resize repaint, but reveal assertions must converge without relying on it.
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
  // Raw-mode Ctrl+C arrives as a byte; restore modes and exit explicitly.
  process.stdout.write('\x1b[?1002l\x1b[?1006l\x1b[?25h\x1b[?2026l', () => process.exit(0))
}

process.stdin.on('data', (data) => {
  if (Buffer.from(data).includes(3)) {
    stop()
  }
})
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
