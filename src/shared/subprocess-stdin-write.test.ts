import { EventEmitter } from 'node:events'
import type { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { endSubprocessStdin } from './subprocess-stdin-write'

describe('endSubprocessStdin', () => {
  it('handles an early-exit pipe error emitted while ending a large write', () => {
    const pipeError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    const stdin = new EventEmitter() as Writable
    stdin.end = vi.fn(() => {
      stdin.emit('error', pipeError)
      return stdin
    }) as Writable['end']
    expect(() => endSubprocessStdin(stdin, 'x'.repeat(1_000_000))).not.toThrow()

    expect(stdin.listenerCount('error')).toBe(0)
  })

  it('keeps the error handler attached for a pipe failure after the caller times out', () => {
    const stdin = new EventEmitter() as Writable
    stdin.end = vi.fn(() => stdin) as Writable['end']
    endSubprocessStdin(stdin, 'payload')
    expect(stdin.listenerCount('error')).toBe(1)

    const pipeError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    expect(() => stdin.emit('error', pipeError)).not.toThrow()

    expect(stdin.listenerCount('error')).toBe(0)
  })
})
