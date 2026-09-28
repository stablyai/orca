import { afterEach, describe, expect, it, vi } from 'vitest'
import { ownRetainedString, resetOwnRetainedStringCopier } from './own-retained-string'
import { createOsc133CommandFinishedScanner } from './terminal-osc133-command-finished'

const FISH_PROMPT = '\x1b]133;A;click_events=1'
const FISH_COMMAND = '\x1b]133;C;cmdline_url=npx'
const UTF16_CARRY = '\x1b]133;D;1234567890;\ud800a\udfff\u0000漢'

function heapAfterGc(): number {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  // Isolate scanner ownership from V8's last successful regexp input.
  void /reset/.test('reset')
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage().heapUsed
}

function selectCopier(withoutBuffer: boolean): void {
  resetOwnRetainedStringCopier()
  try {
    if (withoutBuffer) {
      vi.stubGlobal('Buffer', undefined)
    }
    expect(ownRetainedString(UTF16_CARRY)).toBe(UTF16_CARRY)
  } finally {
    vi.unstubAllGlobals()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetOwnRetainedStringCopier()
})

describe.each([false, true])('OSC 133 carry with Bufferless copying=%s', (withoutBuffer) => {
  // Syntax from the captured fish 4.7.1 fixture in terminal-mode-2031-final-state.test.ts.
  it.each([FISH_PROMPT, FISH_COMMAND])('owns a retained fish suffix %j', (suffix) => {
    selectCopier(withoutBuffer)
    const started = vi.fn()
    const finished = vi.fn()
    const before = heapAfterGc()
    const scanners = Array.from({ length: 8 }, (_value, index) => {
      const scanner = createOsc133CommandFinishedScanner(finished, started)
      scanner.scan(`${index}:${'x'.repeat(4 * 1024 * 1024)}${suffix}`)
      return scanner
    })

    expect(heapAfterGc() - before).toBeLessThan(2 * 1024 * 1024)
    expect(started).not.toHaveBeenCalled()
    expect(finished).not.toHaveBeenCalled()
    for (const scanner of scanners) {
      scanner.scan('\x07\x1b]133;D;137\x1b\\')
    }
    expect(started).toHaveBeenCalledTimes(suffix === FISH_COMMAND ? scanners.length : 0)
    expect(finished.mock.calls).toEqual(Array.from({ length: scanners.length }, () => [137]))
    expect(heapAfterGc() - before).toBeLessThan(2 * 1024 * 1024)
  })

  it('preserves UTF-16 carry at every split and retires a reset prefix', () => {
    selectCopier(withoutBuffer)
    for (let cut = 1; cut < UTF16_CARRY.length; cut += 1) {
      const finished = vi.fn()
      const scanner = createOsc133CommandFinishedScanner(finished)
      scanner.scan(UTF16_CARRY.slice(0, cut))
      scanner.scan(`${UTF16_CARRY.slice(cut)}\x1b\\`)
      expect(finished.mock.calls).toEqual([[1234567890]])
      scanner.scan(FISH_COMMAND)
      scanner.reset()
      scanner.scan('\x07')
      expect(finished.mock.calls).toEqual([[1234567890]])
    }
  })
})

it('short command-finished carry does not retain consumed output and completes once', () => {
  const finished = vi.fn()
  const before = heapAfterGc()
  const scanners = Array.from({ length: 8 }, (_value, index) => {
    const scanner = createOsc133CommandFinishedScanner(finished)
    scanner.scan(`${index}:${'x'.repeat(4 * 1024 * 1024)}\x1b]133;D;0`)
    return scanner
  })
  expect(heapAfterGc() - before).toBeLessThan(2 * 1024 * 1024)
  for (const scanner of scanners) {
    scanner.scan('\x07')
    scanner.scan('\x07')
  }
  expect(finished.mock.calls).toEqual(Array.from({ length: scanners.length }, () => [0]))
})

it('reset releases a pending parent before its terminator arrives', () => {
  const finished = vi.fn()
  const started = vi.fn()
  const before = heapAfterGc()
  const scanners = Array.from({ length: 8 }, (_value, index) => {
    const scanner = createOsc133CommandFinishedScanner(finished, started)
    scanner.scan(`${index}:${'x'.repeat(4 * 1024 * 1024)}${FISH_COMMAND}`)
    scanner.reset()
    return scanner
  })
  expect(heapAfterGc() - before).toBeLessThan(2 * 1024 * 1024)
  for (const scanner of scanners) {
    scanner.scan('\x07')
  }
  expect(started).not.toHaveBeenCalled()
  expect(finished).not.toHaveBeenCalled()
})
