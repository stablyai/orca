#!/usr/bin/env node

const READY_MARKER = 'GOLDEN_STUB_AGENT_READY'
const EXIT_MARKER = 'GOLDEN_STUB_AGENT_EXITED'

const ESC = '\x1b'
// Both match the bytes after ESC, so the control character stays out of the
// pattern: a CSI/SS3 introducer still missing its final byte, and a complete
// CSI/SS3 sequence. Shift+Enter is matched before either is consulted.
const INCOMPLETE_ESCAPE_TAIL_RE = /^(?:\[[0-9;?]*|O)?$/
const ESCAPE_TAIL_RE = /^(?:\[[0-9;?]*[ -/]*[@-~]|O[@-~])/

let composer = ''
let lastSubmission = ''
let pendingInput = ''
let exiting = false

function render() {
  const lines = composer.split('\n')
  const renderedComposer = lines.map((line, index) => `${index === 0 ? '> ' : '  '}${line}`)
  process.stdout.write(
    `\x1b]0;Golden Stub Agent\x07${[
      '\x1b[H\x1b[2JGolden Stub Agent',
      `[${READY_MARKER}]`,
      '',
      ...renderedComposer,
      '',
      'Shift+Enter inserts a newline. Type exit then Enter to quit.',
      ...(lastSubmission ? [`[GOLDEN_STUB_AGENT_SUBMITTED] ${lastSubmission}`] : [])
    ].join('\r\n')}`
  )
}

function exitCleanly() {
  if (exiting) {
    return
  }
  exiting = true
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false)
  }
  process.stdout.write(`\x1b[?1049l[${EXIT_MARKER}]\r\n`, () => process.exit(0))
}

function submit() {
  if (composer.trim() === 'exit') {
    exitCleanly()
    return
  }
  lastSubmission = composer
  composer = ''
  render()
}

function consumeInput() {
  while (pendingInput.length > 0 && !exiting) {
    const shiftEnter = ['\x1b[13;2u', '\x1b[13;2~', '\x1b\r'].find((sequence) =>
      pendingInput.startsWith(sequence)
    )
    if (shiftEnter) {
      pendingInput = pendingInput.slice(shiftEnter.length)
      composer += '\n'
      render()
      continue
    }
    if (pendingInput.startsWith(ESC)) {
      const tail = pendingInput.slice(ESC.length)
      // Wait for the rest of a sequence that is still arriving.
      if (INCOMPLETE_ESCAPE_TAIL_RE.test(tail)) {
        return
      }
      // Why: without this, an unhandled sequence loses its ESC to the sub-space
      // filter below and types its tail ("[A") into the composer, so a stray key
      // report surfaces as a baffling render diff instead of being ignored.
      const escape = ESCAPE_TAIL_RE.exec(tail)
      if (escape) {
        pendingInput = pendingInput.slice(ESC.length + escape[0].length)
        continue
      }
    }

    const char = pendingInput[0]
    pendingInput = pendingInput.slice(1)
    if (char === '\r' || char === '\n') {
      submit()
    } else if (char === '\x04' || char === '\x03') {
      // Raw mode delivers Ctrl+C as \x03 instead of raising SIGINT.
      exitCleanly()
    } else if (char === '\x7f' || char === '\b') {
      composer = composer.slice(0, -1)
      render()
    } else if (char >= ' ') {
      composer += char
      render()
    }
  }
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  pendingInput += typeof chunk === 'string' ? chunk : chunk.toString()
  consumeInput()
})
process.stdin.resume()

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, exitCleanly)
}

process.stdout.write('\x1b[?1049h')
render()
