const fs = require('node:fs')

const logPath = process.argv[2]
let armed = false
let pendingInput = ''

function log(message) {
  fs.appendFileSync(logPath, `${message}\n`)
}

function write(data) {
  process.stdout.write(data)
}

function paintCapturedFrame() {
  const cols = Math.max(40, process.stdout.columns || 80)
  const rows = Math.max(12, process.stdout.rows || 24)
  const frameRows = Math.min(18, rows - 2)
  let frame = '\x1b[?2026h\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l'
  for (let row = 0; row < frameRows; row += 1) {
    const label = `STALE_FRAME_ROW_${String(row).padStart(2, '0')}`
    frame += `\x1b[48;5;240m${label.padEnd(cols, ' ')}\x1b[0m`
    if (row + 1 < frameRows) {
      frame += '\r\n'
    }
  }
  frame += '\x1b[?2026l'
  write(frame)
  log(`READY pid=${process.pid} cols=${cols} rows=${rows}`)
}

function paintPartialResize() {
  const cols = Math.max(1, process.stdout.columns || 0)
  const rows = Math.max(1, process.stdout.rows || 0)
  write(`\x1b[?2026h\x1b[H\x1b[2KREPAINT_AFTER_RESIZE cols=${cols} rows=${rows}\x1b[?2026l`)
  log(`RESIZE cols=${cols} rows=${rows}`)
}

function cleanup() {
  write('\x1b[?25h\x1b[?1049l')
  process.exit(0)
}

process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
}
process.stdin.resume()

process.stdin.on('data', (chunk) => {
  const input = String(chunk)
  if (input.includes('\x03') || input.includes('q')) {
    cleanup()
    return
  }
  pendingInput += input
  if (pendingInput.includes('ARM_REPAINT')) {
    armed = true
    pendingInput = ''
    log('ARMED')
  } else {
    pendingInput = pendingInput.slice(-32)
  }
})

process.on('SIGWINCH', () => {
  if (armed) {
    paintPartialResize()
  }
})
process.on('SIGINT', cleanup)

paintCapturedFrame()
