// Fills scrollback, then enables kitty release reporting (as Codex does) and
// records every byte the terminal sends so a spec can assert nothing leaked.
// A PROBE marker is kept out of that log and acknowledged in a separate file,
// so the spec knows every byte sent before it has already been recorded.
const fs = require('node:fs')
const { createInputProbeSplitter } = require('./terminal-input-probe-splitter.cjs')

const ESC = '\x1b'
const PROBE = `${ESC}]orca-kitty-probe${ESC}\\`
const inputLogPath = process.argv[2]
const probeAckPath = process.argv[3]

const lines = Array.from({ length: 300 }, (_value, index) => `scrollback line ${index + 1}`)
process.stdout.write(`${lines.join('\r\n')}\r\n`)
process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
}
process.stdin.resume()
// CSI > 3 u: push DISAMBIGUATE_ESCAPE_CODES | REPORT_EVENT_TYPES.
process.stdout.write(`${ESC}[>3uKITTY_RELEASE_FIXTURE_READY`)
const splitProbe = createInputProbeSplitter(PROBE)
process.stdin.on('data', (chunk) => {
  const { logged, probes } = splitProbe(chunk)
  if (inputLogPath && logged) {
    fs.appendFileSync(inputLogPath, logged)
  }
  if (probeAckPath && probes > 0) {
    fs.appendFileSync(probeAckPath, 'ack\n')
  }
  if (chunk.includes('\x03') || chunk.includes(`${ESC}[99;5u`)) {
    process.stdout.write(`${ESC}[<u\r\n`)
    process.exit(0)
  }
})
