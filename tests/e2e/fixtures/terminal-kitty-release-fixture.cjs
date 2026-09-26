// Fills scrollback, then enables kitty release reporting (as Codex does) and
// records every byte the terminal sends so a spec can assert nothing leaked.
const fs = require('node:fs')

const ESC = '\x1b'
const inputLogPath = process.argv[2]

const lines = Array.from({ length: 300 }, (_value, index) => `scrollback line ${index + 1}`)
process.stdout.write(`${lines.join('\r\n')}\r\n`)
process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
}
process.stdin.resume()
// CSI > 3 u: push DISAMBIGUATE_ESCAPE_CODES | REPORT_EVENT_TYPES.
process.stdout.write(`${ESC}[>3uKITTY_RELEASE_FIXTURE_READY`)
process.stdin.on('data', (chunk) => {
  if (inputLogPath) {
    fs.appendFileSync(inputLogPath, chunk)
  }
  if (chunk.includes('\x03') || chunk.includes(`${ESC}[99;5u`)) {
    process.stdout.write(`${ESC}[<u\r\n`)
    process.exit(0)
  }
})
