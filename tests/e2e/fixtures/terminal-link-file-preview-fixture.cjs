const fs = require('node:fs')

const ESC = '\x1b'
const INPUT_PATTERN = new RegExp(String.raw`\x1b\[<\d+;\d+;\d+[Mm]|[pq]`, 'g')
const [logPath, filePath, mouseMode = '1000'] = process.argv.slice(2)
let pending = ''

if (!logPath || !filePath || !['1000', '1002', '1003'].includes(mouseMode)) {
  throw new Error('Expected a mouse-report log path, file path and mouse mode (1000/1002/1003)')
}

function cleanup() {
  process.stdout.write(
    `${ESC}[?1000l${ESC}[?1002l${ESC}[?1003l${ESC}[?1006l${ESC}[?25h${ESC}[?1049l`
  )
  process.exit(0)
}

const packageJson = JSON.parse(fs.readFileSync(filePath, 'utf8'))
packageJson.filePreviewLines = Array.from({ length: 30 }, (_, index) => `Preview line ${index + 1}`)
fs.writeFileSync(filePath, `${JSON.stringify(packageJson, null, 2)}\n`)
fs.writeFileSync(logPath, '')
process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
}
process.stdin.resume()

const link = `${filePath}:2`
const wrappedRows = Math.ceil(link.length / (process.stdout.columns || 80))
const linkRow = Math.max(3, (process.stdout.rows || 24) - wrappedRows)
process.stdout.write(
  `${ESC}[?1049h${ESC}[?${mouseMode}h${ESC}[?1006h${ESC}[?25l${ESC}[2J${ESC}[H` +
    `FILE_PREVIEW_MOUSE_READY ${mouseMode}+1006\r\nPress p to acknowledge input; q to exit` +
    `${ESC}[${linkRow};1H${link}`
)

process.stdin.on('data', (chunk) => {
  const text = String(chunk)
  if (text.includes('\x03')) {
    cleanup()
  }
  pending += text
  const tokens = [...pending.matchAll(INPUT_PATTERN)]
  for (const { 0: token } of tokens) {
    if (token === 'q') {
      cleanup()
    }
    fs.appendFileSync(
      logPath,
      token === 'p' ? 'KEY p\n' : `${Buffer.from(token).toString('hex')}\n`
    )
  }
  const last = tokens.at(-1)
  pending = last ? pending.slice(last.index + last[0].length) : pending.slice(-64)
})

process.on('SIGINT', cleanup)
