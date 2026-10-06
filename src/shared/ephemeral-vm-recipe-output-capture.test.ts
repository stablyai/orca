import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clampRecipeCaptureBytes,
  DEFAULT_MAX_CAPTURE_BYTES,
  runRecipeCommand
} from './ephemeral-vm-recipe-process'
import { GrowingByteBuffer } from './growing-byte-buffer'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** The pre-ring policy: re-encode the retained tail on every chunk and trim to a character boundary. */
function oldAppend(current: string, chunk: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return ''
  }
  const chunkBytes = Buffer.byteLength(chunk, 'utf8')
  return chunkBytes >= maxBytes
    ? utf8Tail(chunk, maxBytes)
    : utf8Tail(current, maxBytes - chunkBytes) + chunk
}

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength <= maxBytes) {
    return value
  }
  let start = bytes.byteLength - maxBytes
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) {
    start += 1
  }
  return bytes.subarray(start).toString('utf8')
}

/** What the capture now retains: the last maxBytes raw bytes, minus a leading partial sequence. */
function rawByteTail(bytes: Buffer, maxBytes: number): string {
  let start = Math.max(0, bytes.byteLength - maxBytes)
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) {
    start += 1
  }
  return bytes.toString('utf8', start)
}

/** Independent oracle: keep whole code points from the end until the byte limit is reached. */
function codePointTail(text: string, maxBytes: number): string {
  const points = Array.from(text)
  const retained: string[] = []
  let bytes = 0
  while (points.length > 0) {
    const point = points.pop()!
    bytes += Buffer.byteLength(point, 'utf8')
    if (bytes > maxBytes) {
      break
    }
    retained.unshift(point)
  }
  return retained.join('')
}

function deterministicRandom(seed: number): (max: number) => number {
  let state = seed
  return (max: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return max <= 0 ? 0 : state % max
  }
}

function fakeCommand(maxCaptureBytes?: number, signal?: AbortSignal) {
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true),
    unref: vi.fn()
  })
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const result = runRecipeCommand({
    command: 'synthetic-recipe',
    repoPath: process.cwd(),
    context: { recipeId: 'fixture', repoPath: process.cwd() },
    mode: 'create',
    resultSchemaVersion: 1,
    maxCaptureBytes,
    signal,
    onStdout: (chunk) => stdoutChunks.push(chunk),
    onStderr: (chunk) => stderrChunks.push(chunk),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture implements every child member used by runRecipeCommand.
    spawnCommand: vi.fn(() => child) as never
  })
  return { child, result, stdoutChunks, stderrChunks }
}

/**
 * Counts the bytes the capture moves, scoped to our own buffer class: a spy on Buffer itself would
 * also see unrelated allocations in the same tick and make the budget assertions flaky.
 */
function countCaptureWork() {
  const appendedValues: (Buffer | Uint8Array)[] = []
  const counts = { appendedBytes: 0, decodedBytes: 0, decodeCalls: 0 }
  const append = GrowingByteBuffer.prototype.appendRetainedSuffix
  const take = GrowingByteBuffer.prototype.takeBuffer
  vi.spyOn(GrowingByteBuffer.prototype, 'appendRetainedSuffix').mockImplementation(function (
    this: GrowingByteBuffer,
    bytes: Buffer | Uint8Array,
    maxBytes: number
  ): void {
    appendedValues.push(bytes)
    counts.appendedBytes += bytes.byteLength
    append.call(this, bytes, maxBytes)
  })
  vi.spyOn(GrowingByteBuffer.prototype, 'takeBuffer').mockImplementation(function (
    this: GrowingByteBuffer
  ): Buffer {
    const taken = take.call(this)
    counts.decodeCalls += 1
    counts.decodedBytes += taken.byteLength
    return taken
  })
  return { appendedValues, counts }
}

describe('recipe output capture', () => {
  it.each([0, -1, 1, 2, 3, 4, 7, 16, 255, 256, 257, 1024])(
    'matches the old per-chunk UTF-8 tail for limit %s across varied chunk boundaries',
    async (limit) => {
      const random = deterministicRandom(0x19780728)
      const alphabet = ['a', '\0', '\n', 'é', '中', '😀', '�', '́']
      for (let sample = 0; sample < 4; sample += 1) {
        const fixture = fakeCommand(limit)
        let expected = ''
        for (let index = 0; index < 80; index += 1) {
          const chunk = Array.from(
            { length: random(40) },
            () => alphabet[random(alphabet.length)]
          ).join('')
          fixture.child.stdout.emit('data', Buffer.from(chunk, 'utf8'))
          expected = oldAppend(expected, chunk, limit)
        }
        fixture.child.emit('close', 0, null)
        await expect(fixture.result).resolves.toMatchObject({ stdout: expected, stderr: '' })
      }
    }
  )

  it('does not restore bytes discarded at an earlier chunk boundary', async () => {
    const fixture = fakeCommand(5)
    for (const chunk of ['😀', 'ab', 'c']) {
      fixture.child.stdout.emit('data', Buffer.from(chunk, 'utf8'))
    }
    fixture.child.emit('close', 0, null)
    await expect(fixture.result).resolves.toMatchObject({ stdout: 'abc' })
  })

  it.each([1, 7, 31, 255, 4097])(
    'retains the same code-point tail for limit %s wherever byte boundaries fall',
    async (limit) => {
      const random = deterministicRandom(0x5eed1234 + limit)
      let text = ''
      for (let index = 0; index < 2000; index += 1) {
        text += index % 29 === 0 ? 'a中😀é'.repeat(200) : ['x', '😀', '中', 'é'][index % 4]
      }
      const bytes = Buffer.from(text, 'utf8')
      const fixture = fakeCommand(limit)
      // Split mid-character on purpose: retention is over raw bytes, so the tail must not depend on it.
      for (let cursor = 0; cursor < bytes.byteLength;) {
        const size = Math.min(1 + random(2048), bytes.byteLength - cursor)
        fixture.child.stdout.emit('data', bytes.subarray(cursor, cursor + size))
        cursor += size
      }
      fixture.child.emit('close', 0, null)
      const result = await fixture.result
      expect(result.stdout).toBe(codePointTail(text, limit))
      expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(limit)
    }
  )

  it('preserves stream decoding, callback boundaries and independent tails', async () => {
    const fixture = fakeCommand(9)
    const stdoutBytes = Buffer.from('α😀中文invalid:�:end')
    const stderrBytes = Buffer.from('stderr:\n😀!')
    const malformed = Buffer.from([0xff, 0xe2, 0x28, 0xa1])
    for (const byte of stdoutBytes) {
      fixture.child.stdout.write(Buffer.from([byte]))
    }
    for (const byte of stderrBytes) {
      fixture.child.stderr.write(Buffer.from([byte]))
    }
    fixture.child.stdout.write(malformed)
    fixture.child.emit('close', 17, null)
    const result = await fixture.result
    // Callbacks still see exactly what setEncoding('utf8') produced, split character by character.
    expect(fixture.stdoutChunks.join('')).toBe(`${stdoutBytes.toString()}��(�`)
    expect(fixture.stderrChunks.join('')).toBe(stderrBytes.toString())
    // The tail is now the last 9 raw bytes rather than the last 9 bytes of re-encoded replacement
    // characters, so malformed output keeps more of what the recipe actually wrote.
    expect(result).toEqual({
      stdout: rawByteTail(Buffer.concat([stdoutBytes, malformed]), 9),
      stderr: rawByteTail(stderrBytes, 9),
      exitCode: 17,
      signal: null
    })
    expect(result.stdout).toBe(':end��(�')
  })

  it('moves at most 5 MiB through the capture for 4 MiB of output', async () => {
    const fixture = fakeCommand()
    const chunk = Buffer.from('a'.repeat(4096))
    const { appendedValues, counts } = countCaptureWork()
    for (let index = 0; index < 1024; index += 1) {
      fixture.child.stdout.emit('data', chunk)
    }
    fixture.child.emit('close', 0, null)
    const result = await fixture.result
    expect(result.stdout).toBe('a'.repeat(1024 * 1024))
    expect(fixture.stdoutChunks).toHaveLength(1024)
    // The pre-ring policy re-encoded the retained tail per chunk: 943,194,112 bytes for this input.
    expect(counts.appendedBytes + counts.decodedBytes).toBeLessThanOrEqual(5 * 1024 * 1024)
    expect(counts.appendedBytes).toBe(4 * 1024 * 1024)
    expect(counts.decodedBytes).toBe(1024 * 1024)
    // Nothing is encoded: the capture stores the very Buffers the stream delivered.
    expect(appendedValues.every((value) => value === chunk)).toBe(true)
  })

  it('returns the captured tails when cancellation needs force-kill', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const fixture = fakeCommand(6, controller.signal)
    fixture.child.stdout.emit('data', Buffer.from('abc😀Z'))
    fixture.child.stderr.emit('data', Buffer.from('error tail'))
    controller.abort()
    fixture.child.stdout.emit('data', Buffer.from('!'))
    await vi.advanceTimersByTimeAsync(5000)
    await expect(fixture.result).resolves.toEqual({
      stdout: '😀Z!',
      stderr: 'r tail',
      exitCode: null,
      signal: null,
      aborted: true
    })
    expect(fixture.child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect(fixture.child.unref).toHaveBeenCalledOnce()
  })

  it('preserves failures after output and synchronous spawn errors', async () => {
    const fixture = fakeCommand(5)
    const error = new Error('recipe failed')
    fixture.child.stdout.emit('data', Buffer.from('earlier output'))
    fixture.child.emit('error', error)
    await expect(fixture.result).rejects.toBe(error)
    fixture.child.emit('close', 1, null)
    await expect(
      runRecipeCommand({
        command: 'synthetic-recipe',
        repoPath: process.cwd(),
        context: { recipeId: 'fixture', repoPath: process.cwd() },
        mode: 'create',
        resultSchemaVersion: 1,
        spawnCommand: () => {
          throw error
        }
      })
    ).rejects.toBe(error)
  })

  it.each(['close', 'error'])(
    'releases capture storage after %s while preserving late callbacks',
    async (event) => {
      if (!global.gc) {
        throw new Error('This regression requires --expose-gc')
      }
      const fixture = fakeCommand(128 * 1024)
      const allocations: WeakRef<Buffer>[] = []
      const allocUnsafe = Buffer.allocUnsafe
      const allocationSpy = vi.spyOn(Buffer, 'allocUnsafe').mockImplementation((size) => {
        const bytes = allocUnsafe(size)
        allocations.push(new WeakRef(bytes))
        return bytes
      })
      for (let index = 0; index < 3; index++) {
        fixture.child.stdout.emit('data', Buffer.from('a'.repeat(4096)))
        fixture.child.stderr.emit('data', Buffer.from('b'.repeat(4096)))
      }
      allocationSpy.mockRestore()
      if (event === 'error') {
        fixture.child.emit('error', new Error('recipe failed'))
        await expect(fixture.result).rejects.toThrow('recipe failed')
      } else {
        fixture.child.emit('close', 0, null)
        await expect(fixture.result).resolves.toMatchObject({
          stdout: 'a'.repeat(3 * 4096),
          stderr: 'b'.repeat(3 * 4096)
        })
      }
      for (let turn = 0; turn < 3; turn++) {
        await setImmediate()
        global.gc()
      }
      expect(allocations.length).toBeGreaterThan(0)
      expect(allocations.filter((ref) => ref.deref() !== undefined)).toHaveLength(0)
      const { counts } = countCaptureWork()
      fixture.child.stdout.emit('data', Buffer.from('late stdout'))
      fixture.child.stderr.emit('data', Buffer.from('late stderr'))
      fixture.child.emit('close', 1, null)
      expect(counts).toEqual({ appendedBytes: 0, decodedBytes: 0, decodeCalls: 0 })
      expect(fixture.stdoutChunks.at(-1)).toBe('late stdout')
      expect(fixture.stderrChunks.at(-1)).toBe('late stderr')
    }
  )

  it('decodes once per stream when force-kill closes synchronously', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const fixture = fakeCommand(8, controller.signal)
    fixture.child.kill.mockImplementation((signal) => {
      if (signal === 'SIGKILL') {
        fixture.child.emit('close', null, 'SIGKILL')
      }
      return true
    })
    fixture.child.stdout.emit('data', Buffer.from('before😀'))
    const { counts } = countCaptureWork()
    controller.abort()
    await vi.advanceTimersByTimeAsync(5000)
    await expect(fixture.result).resolves.toEqual({
      stdout: 'fore😀',
      stderr: '',
      exitCode: null,
      signal: 'SIGKILL',
      aborted: true
    })
    expect(vi.getTimerCount()).toBe(0)
    expect(counts.decodeCalls).toBe(2)
  })

  it.each([
    { limit: undefined, expected: DEFAULT_MAX_CAPTURE_BYTES },
    { limit: 1024, expected: 1024 },
    { limit: 1.5, expected: 1 },
    { limit: 4.5, expected: 4 },
    { limit: 0, expected: 0 },
    { limit: -1, expected: 0 },
    { limit: -Infinity, expected: 0 },
    { limit: Number.NaN, expected: DEFAULT_MAX_CAPTURE_BYTES },
    { limit: Infinity, expected: DEFAULT_MAX_CAPTURE_BYTES },
    { limit: Number.MAX_VALUE, expected: DEFAULT_MAX_CAPTURE_BYTES }
  ])('clamps a $limit capture limit to a bounded byte count', ({ limit, expected }) => {
    expect(clampRecipeCaptureBytes(limit)).toBe(expected)
  })
})
