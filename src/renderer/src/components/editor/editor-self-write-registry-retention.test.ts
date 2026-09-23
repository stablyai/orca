import { setImmediate as nextTurn } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __clearSelfWriteRegistryForTests,
  __getSelfWriteRegistrySizeForTests,
  clearSelfWrite,
  getRecentSelfWrite,
  recordSelfWrite,
  SELF_WRITE_REMOTE_TTL_MS
} from './editor-self-write-registry'

async function collect(): Promise<void> {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 4; round += 1) {
    await nextTurn()
    globalThis.gc()
  }
}

describe('idle editor self-write expiry', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    __clearSelfWriteRegistryForTests()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('reclaims large file contents after idle expiry without another registry access', async () => {
    await collect()
    const baseline = process.memoryUsage().external
    const contentBytes = 16 * 2 * 1024 * 1024
    for (let index = 0; index < 16; index += 1) {
      recordSelfWrite(
        `/folder/${index}`,
        Buffer.alloc(2 * 1024 * 1024, index + 65).toString('utf8'),
        'paired',
        SELF_WRITE_REMOTE_TTL_MS
      )
    }
    await collect()
    const retained = process.memoryUsage().external
    expect(retained - baseline).toBeGreaterThan(contentBytes * 0.9)
    vi.advanceTimersByTime(SELF_WRITE_REMOTE_TTL_MS + 1)
    await collect()
    expect(retained - process.memoryUsage().external).toBeGreaterThan(contentBytes * 0.9)
    expect(__getSelfWriteRegistrySizeForTests()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('expires local entries while preserving exact remote contents and the inclusive TTL boundary', () => {
    recordSelfWrite('/folder/file', 'remote', 'paired', SELF_WRITE_REMOTE_TTL_MS)
    recordSelfWrite('/folder/file', 'local')
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(750)
    expect(getRecentSelfWrite('/folder/file')).toEqual({ content: 'local' })
    vi.advanceTimersByTime(1)
    expect(__getSelfWriteRegistrySizeForTests()).toBe(1)
    expect(getRecentSelfWrite('/folder/file', 'paired')).toEqual({ content: 'remote' })
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(SELF_WRITE_REMOTE_TTL_MS - 750)
    expect(__getSelfWriteRegistrySizeForTests()).toBe(0)
  })

  it('keeps replacement writes until their own expiry and stops when the last stamp is cleared', () => {
    recordSelfWrite('/folder/file', 'first')
    vi.advanceTimersByTime(500)
    recordSelfWrite('/folder/file', 'replacement', undefined, SELF_WRITE_REMOTE_TTL_MS)
    vi.advanceTimersByTime(251)
    expect(getRecentSelfWrite('/folder/file')).toEqual({ content: 'replacement' })
    expect(vi.getTimerCount()).toBe(1)
    clearSelfWrite('/folder/file')
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(SELF_WRITE_REMOTE_TTL_MS)
    expect(__getSelfWriteRegistrySizeForTests()).toBe(0)
  })

  it('retains only one expiry timer while enforcing the stamp count cap', () => {
    for (let index = 0; index < 300; index += 1) {
      recordSelfWrite(`/folder/${index}`, 'content')
    }
    expect(__getSelfWriteRegistrySizeForTests()).toBe(256)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(751)
    expect(__getSelfWriteRegistrySizeForTests()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
