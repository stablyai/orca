// Bun: isolated protocol harness with actual read-only OMP ProcessTerminal.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PtyStartupIngress } from '../../src/shared/pty-startup-ingress.ts'

assert.ok(process.argv[2], 'Pass the read-only OMP checkout')
const scratch = await mkdtemp(join(tmpdir(), 'orca-omp-keyboard-'))
process.env.HOME = join(scratch, 'home')
await mkdir(process.env.HOME)
const { setTerminalHeadless } = await import(
  pathToFileURL(join(resolve(process.argv[2]), 'packages/utils/src/env.ts')).href
)
const { ProcessTerminal } = await import(
  pathToFileURL(join(resolve(process.argv[2]), 'packages/tui/src/terminal.ts')).href
)
const originalWrite = process.stdout.write
const originalRawMode = process.stdin.setRawMode
const originalResume = process.stdin.resume
process.stdin.setRawMode = () => process.stdin
process.stdin.resume = () => process.stdin
const emitted = []
const replies = []
let terminal
let ingress
try {
  assert.ok(!process.stdout.isTTY, 'Run with piped stdout to keep native terminal effects isolated')
  ingress = new PtyStartupIngress({
    intent: {
      colors: { foreground: '#ffffff', background: '#000000' },
      deadlineMs: 5000,
      kittyKeyboardProtocol: true
    },
    write: (data) => {
      replies.push(data)
      queueMicrotask(() => process.stdin.emit('data', data))
    },
    onEmission: (span) => emitted.push(span)
  })
  process.stdout.write = (data) => {
    ingress.accept(String(data))
    return true
  }
  terminal = new ProcessTerminal()
  terminal.start(
    () => {},
    () => {},
    () => {},
    { deferInput: true }
  )
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  terminal.enableInput()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(terminal.kittyProtocolActive, true)
  assert.equal(replies.filter((reply) => reply === '\x1b[?0u').length, 1)
  assert.ok(
    emitted
      .map((span) => span.data)
      .join('')
      .includes(terminal.kittyEnableSequence)
  )
  assert.ok(
    !emitted
      .map((span) => span.data)
      .join('')
      .includes('\x1b[?u')
  )
  terminal.stop()
  ingress.drainAndClose()
  let end = 0
  for (const span of emitted) {
    assert.equal(span.rawStartSeq, end)
    end = span.rawEndSeq
  }
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
  process.stdout.write = originalWrite
  console.log(
    JSON.stringify({
      actualOmpProcessTerminal: true,
      kittyActive: true,
      singleReply: true,
      modePushPreserved: true,
      sequenceCoverage: end,
      rendererAttached: false,
      modelCalls: 0
    })
  )
} finally {
  terminal?.stop()
  setTerminalHeadless(true)
  ingress?.drainAndClose()
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
  process.stdout.write = originalWrite
  process.stdin.setRawMode = originalRawMode
  process.stdin.resume = originalResume
  await rm(scratch, { recursive: true, force: true })
}
