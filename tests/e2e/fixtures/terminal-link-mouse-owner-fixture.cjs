const fs = require('node:fs')

const ESC = '\x1b'
const LINK = 'https://example.com/sta-3888'
const OSC_LINK_TEXT = 'STA_3888_OSC_LINK'
const SGR_MOUSE_REPORT_PATTERN = new RegExp(String.raw`\x1b\[<\d+;\d+;\d+[Mm]`, 'g')
const logPath = process.argv[2]
const linkMode = process.argv[3] ?? 'http'
let pending = ''

if (!logPath) {
  throw new Error('Expected a mouse-report log path')
}

function cleanup() {
  process.stdout.write(`${ESC}[?1000l${ESC}[?1006l${ESC}[?25h${ESC}[?1049l`)
  process.exit(0)
}

process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
}
process.stdin.resume()

const renderedLink =
  linkMode === 'osc' ? `${ESC}]8;;${LINK}\x07${OSC_LINK_TEXT}${ESC}]8;;\x07` : LINK
process.stdout.write(
  `${ESC}[?1049h${ESC}[?1000h${ESC}[?1006h${ESC}[?25l${ESC}[2J${ESC}[H` +
    `LINK_MOUSE_READY ${renderedLink}\r\nPress q to exit`
)

process.stdin.on('data', (chunk) => {
  if (chunk.includes('\x03') || chunk.includes('q')) {
    cleanup()
  }

  pending += String(chunk)
  const reports = pending.match(SGR_MOUSE_REPORT_PATTERN) ?? []
  if (reports.length > 0) {
    const encodedReports = reports.map((report) => Buffer.from(report).toString('hex')).join('\n')
    fs.appendFileSync(logPath, `${encodedReports}\n`)
    pending = pending.slice(pending.lastIndexOf(reports.at(-1)) + reports.at(-1).length)
  } else {
    pending = pending.slice(-64)
  }
})

process.on('SIGINT', cleanup)
