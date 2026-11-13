import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createOsc133CommandFinishedScanner } from './terminal-osc133-command-finished'

// Real OMP 18.10.3 PTY bytes for one prompt: each user bubble ends with `B C D;0` (#10923).
const OMP_TRANSCRIPT = readFileSync(
  join(__dirname, '../../../main/runtime/__fixtures__/omp-user-bubble-osc133-zone.txt'),
  'utf8'
)
const C = '\x1b]133;C\x07'
const D0 = '\x1b]133;D;0\x07'
const A = '\x1b]133;A\x07'
const B = '\x1b]133;B\x07'

function scanChunks(chunks: string[]) {
  const finished: (number | null)[] = []
  let started = 0
  let shellStarted = 0
  const scanner = createOsc133CommandFinishedScanner(
    (exitCode) => finished.push(exitCode),
    () => {
      started += 1
    },
    () => {
      shellStarted += 1
    }
  )
  for (const chunk of chunks) {
    scanner.scan(chunk)
  }
  return { started, shellStarted, finished }
}

function splitEvery(text: string, size: number): string[] {
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size))
  }
  return chunks
}

describe('OSC 133 zone an app closes for itself', () => {
  it.each([1, 3, 7, 64, OMP_TRANSCRIPT.length])(
    'does not read OMP user bubbles as the command finishing (chunks of %d)',
    (size) => {
      expect(OMP_TRANSCRIPT).toContain(`\x1b]133;B\x07${C}${D0}`)
      const { started, shellStarted, finished } = scanChunks(splitEvery(OMP_TRANSCRIPT, size))
      expect(finished).toEqual([])
      expect(started).toBeGreaterThan(0)
      expect(shellStarted).toBe(0)
    }
  )

  it('drops a zone close split across chunks', () => {
    expect(scanChunks([B, C, '\x1b]13', '3;D;0\x07'])).toEqual({
      started: 1,
      shellStarted: 0,
      finished: []
    })
  })

  it('still finishes a silent shell command right after its start', () => {
    expect(scanChunks([`${C}${D0}${A}$ `]).finished).toEqual([0])
    expect(scanChunks([C, D0]).finished).toEqual([0])
    expect(scanChunks([C, D0]).shellStarted).toBe(1)
  })

  it("finishes a command typed after the prompt's own B", () => {
    expect(scanChunks([`${A}$ ${B}`, 'ls\r\n', `${C}${D0}${A}`]).finished).toEqual([0])
    expect(scanChunks([`${A}$ ${B}`, 'ls\r\n', C]).shellStarted).toBe(1)
  })

  it('finishes a failed command even straight after a zone end', () => {
    expect(scanChunks([`${B}${C}\x1b]133;D;1\x07`]).finished).toEqual([1])
    expect(scanChunks([B, C, '\x1b]133;D;1\x1b\\']).shellStarted).toBe(1)
  })

  it('keeps a split zone unresolved until its bytes distinguish a shell start', () => {
    const starts: number[] = []
    const scanner = createOsc133CommandFinishedScanner(
      () => {},
      undefined,
      (end) => starts.push(end)
    )
    scanner.scan(`${B}${C}`)
    expect(scanner.hasPendingCommandStart()).toBe(true)
    expect(starts).toEqual([])
    scanner.scan('first command output')
    expect(scanner.hasPendingCommandStart()).toBe(false)
    expect(starts).toEqual([0])
    scanner.scan(`${B}${C}`)
    scanner.reset()
    expect(scanner.hasPendingCommandStart()).toBe(false)
    scanner.scan(D0)
    expect(starts).toEqual([0])
  })

  it('forgets the zone end on reset', () => {
    const finished = vi.fn()
    const scanner = createOsc133CommandFinishedScanner(finished)
    scanner.scan(`${B}${C}`)
    scanner.reset()
    scanner.scan(D0)
    expect(finished).toHaveBeenCalledExactlyOnceWith(0)
  })
})
