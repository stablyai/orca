const fs = require('node:fs')

const ESC = '\x1b'
const MOUSE_REPORT_PATTERN = new RegExp(`${ESC}\\[<(64|65);\\d+;\\d+M`, 'g')

// Optional flags:
//   --log <path>   append "<Date.now()> <reportsInChunk>" per consumed stdin
//                  chunk so tests can measure when reports reached the PTY.
//   --heavy        emit Claude-Code-scale redraw frames (~4KB of styled cells
//                  per render, ~430KB/s at 120 reports/s — matches output
//                  volume measured from a real Claude Code session scrolling
//                  at 120 reports/s) instead of minimal rows.
const args = process.argv.slice(2)
const logIndex = args.indexOf('--log')
const LOG_PATH = logIndex >= 0 ? args[logIndex + 1] : null
const HEAVY_FRAMES = args.includes('--heavy')

let offset = 0
let pending = ''

function write(data) {
  process.stdout.write(data)
}

function visibleRows() {
  return Math.max(3, process.stdout.rows || 24)
}

function visibleCols() {
  return Math.max(20, process.stdout.columns || 80)
}

function heavyRowFiller(row, cols) {
  // ~19 bytes per 8 visible columns of styled filler.
  const unit = `${ESC}[38;5;${((row * 17) % 200) + 16}m········`
  const units = Math.max(0, Math.floor((cols - 24) / 8))
  return `${unit.repeat(units)}${ESC}[0m`
}

function render() {
  const rows = visibleRows()
  const cols = visibleCols()
  let frame = `${ESC}[?2026h${ESC}[H`
  frame += `TUI_SCROLL_READY offset=${offset}${ESC}[K`
  for (let row = 1; row < rows; row += 1) {
    const label = `TUI_SCROLL_ROW_${String(offset + row - 1).padStart(4, '0')}`
    frame += `\r\n${label}${HEAVY_FRAMES ? ` ${heavyRowFiller(row, cols)}` : ''}${ESC}[K`
  }
  frame += `${ESC}[?2026l`
  write(frame)
}

function cleanup() {
  write(`${ESC}[?1003l${ESC}[?1006l${ESC}[?25h${ESC}[?1049l`)
  process.exit(0)
}

process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
}
process.stdin.resume()

write(`${ESC}[?1049h${ESC}[?1003h${ESC}[?1006h${ESC}[?25l${ESC}[2J`)
render()

process.stdin.on('data', (chunk) => {
  if (chunk.includes('\x03') || chunk.includes('q')) {
    cleanup()
  }

  pending += chunk
  let match
  let lastIndex = 0
  let reportsInChunk = 0

  MOUSE_REPORT_PATTERN.lastIndex = 0
  while ((match = MOUSE_REPORT_PATTERN.exec(pending)) !== null) {
    offset = Math.max(0, offset + (match[1] === '65' ? 1 : -1))
    reportsInChunk += 1
    lastIndex = MOUSE_REPORT_PATTERN.lastIndex
  }

  if (lastIndex > 0) {
    if (LOG_PATH) {
      fs.appendFileSync(LOG_PATH, `${Date.now()} ${reportsInChunk}\n`)
    }
    pending = pending.slice(lastIndex)
    render()
    return
  }

  pending = pending.slice(-32)
})

process.on('SIGINT', cleanup)
