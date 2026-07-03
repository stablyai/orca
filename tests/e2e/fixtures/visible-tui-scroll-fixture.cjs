const ESC = '\x1b'
const MOUSE_REPORT_PATTERN = new RegExp(`${ESC}\\[<(64|65);\\d+;\\d+M`, 'g')

let offset = 0
let pending = ''

function write(data) {
  process.stdout.write(data)
}

function visibleRows() {
  return Math.max(3, process.stdout.rows || 24)
}

function render() {
  write(`${ESC}[H`)
  write(`TUI_SCROLL_READY offset=${offset}${ESC}[K`)
  for (let row = 1; row < visibleRows(); row += 1) {
    write(`\r\nTUI_SCROLL_ROW_${String(offset + row - 1).padStart(4, '0')}${ESC}[K`)
  }
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

  MOUSE_REPORT_PATTERN.lastIndex = 0
  while ((match = MOUSE_REPORT_PATTERN.exec(pending)) !== null) {
    offset = Math.max(0, offset + (match[1] === '65' ? 1 : -1))
    lastIndex = MOUSE_REPORT_PATTERN.lastIndex
  }

  if (lastIndex > 0) {
    pending = pending.slice(lastIndex)
    render()
    return
  }

  pending = pending.slice(-32)
})

process.on('SIGINT', cleanup)
