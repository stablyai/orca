import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runRecipeCommand } from './ephemeral-vm-recipe-process'
import { RecipeOutputCapture } from './ephemeral-vm-recipe-output-capture'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function oldAppend(current: string, chunk: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return ''
  }
  const tail = (text: string, limit: number): string => {
    const bytes = Buffer.from(text, 'utf8')
    if (bytes.length <= limit) {
      return text
    }
    let start = bytes.length - limit
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) {
      start += 1
    }
    return bytes.subarray(start).toString('utf8')
  }
  const chunkBytes = Buffer.byteLength(chunk, 'utf8')
  return chunkBytes >= maxBytes
    ? tail(chunk, maxBytes)
    : tail(current, maxBytes - chunkBytes) + chunk
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

describe('recipe output capture', () => {
  it.each([
    0,
    -1,
    -Infinity,
    1,
    2,
    3,
    4,
    7,
    16,
    255,
    256,
    257,
    1024,
    1.5,
    4.5,
    Number.NaN,
    Infinity
  ])('matches the old UTF-8 tail for limit %s across varied chunk boundaries', (limit) => {
    let seed = 0x19780728
    const random = (max: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    const alphabet = ['a', '\0', '\n', 'é', '中', '😀', '\ufffd', '\u0301']
    for (let sample = 0; sample < 20; sample += 1) {
      const capture = new RecipeOutputCapture(limit)
      let expected = ''
      for (let index = 0; index < 80; index += 1) {
        const chunk = Array.from(
          { length: random(40) },
          () => alphabet[random(alphabet.length)]
        ).join('')
        capture.append(chunk)
        expected = oldAppend(expected, chunk, limit)
      }
      expect(capture.takeText()).toBe(expected)
      expect(capture.takeText()).toBe('')
    }
  })

  it('does not restore bytes discarded at an earlier chunk boundary', () => {
    const capture = new RecipeOutputCapture(5)
    capture.append('😀')
    capture.append('ab')
    capture.append('c')
    expect(capture.takeText()).toBe('abc')
  })

  it('matches a code-point oracle through oversized chunks, growth and many ring wraps', () => {
    const encoder = new TextEncoder()
    const tail = (text: string, limit: number): string => {
      const points = Array.from(text)
      const retained: string[] = []
      let bytes = 0
      while (points.length > 0) {
        const point = points.pop()!
        bytes += encoder.encode(point).length
        if (bytes > limit) {
          break
        }
        retained.unshift(point)
      }
      return retained.join('')
    }
    for (const limit of [1, 7, 31, 255, 4097]) {
      const capture = new RecipeOutputCapture(limit)
      let expected = ''
      for (let index = 0; index < 2000; index += 1) {
        const chunk = index % 29 === 0 ? 'a中😀é'.repeat(1000) : ['x', '😀', '中', 'é'][index % 4]
        const bytes = encoder.encode(chunk).length
        expected = bytes >= limit ? tail(chunk, limit) : tail(expected, limit - bytes) + chunk
        capture.append(chunk)
      }
      expect(capture.takeText()).toBe(expected)
    }
  })

  it('preserves stream decoding, callback boundaries and independent tails', async () => {
    const fixture = fakeCommand(9)
    const stdoutBytes = Buffer.from('α😀中文invalid:\ufffd:end')
    const stderrBytes = Buffer.from('stderr:\n😀!')
    for (const byte of stdoutBytes) {
      fixture.child.stdout.write(Buffer.from([byte]))
    }
    for (const byte of stderrBytes) {
      fixture.child.stderr.write(Buffer.from([byte]))
    }
    fixture.child.stdout.write(Buffer.from([0xff, 0xe2, 0x28, 0xa1]))
    fixture.child.emit('close', 17, null)
    const result = await fixture.result
    expect(fixture.stdoutChunks.join('')).toBe(`${stdoutBytes.toString()}��(�`)
    expect(fixture.stderrChunks.join('')).toBe(stderrBytes.toString())
    expect(result).toEqual({
      stdout: fixture.stdoutChunks.reduce((tail, chunk) => oldAppend(tail, chunk, 9), ''),
      stderr: fixture.stderrChunks.reduce((tail, chunk) => oldAppend(tail, chunk, 9), ''),
      exitCode: 17,
      signal: null
    })
  })

  it('keeps capture encoding proportional to incoming output', async () => {
    const fixture = fakeCommand()
    const chunk = 'a'.repeat(4096)
    const from = vi.spyOn(Buffer, 'from')
    for (let index = 0; index < 1024; index += 1) {
      fixture.child.stdout.emit('data', chunk)
    }
    fixture.child.emit('close', 0, null)
    const result = await fixture.result
    const encodedBytes = from.mock.calls.reduce(
      (sum, [value]) => sum + (typeof value === 'string' ? Buffer.byteLength(value) : 0),
      0
    )
    expect(result.stdout).toBe('a'.repeat(1024 * 1024))
    expect(fixture.stdoutChunks).toHaveLength(1024)
    expect(encodedBytes).toBeLessThanOrEqual(5 * 1024 * 1024)
  })

  it('returns the captured tails when cancellation needs force-kill', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const fixture = fakeCommand(6, controller.signal)
    fixture.child.stdout.emit('data', 'abc😀Z')
    fixture.child.stderr.emit('data', 'error tail')
    controller.abort()
    fixture.child.stdout.emit('data', '!')
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
    fixture.child.stdout.emit('data', 'earlier output')
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
        fixture.child.stdout.emit('data', 'a'.repeat(4096))
        fixture.child.stderr.emit('data', 'b'.repeat(4096))
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
      const from = vi.spyOn(Buffer, 'from')
      const decode = vi.spyOn(Buffer.prototype, 'toString')
      fixture.child.stdout.emit('data', 'late stdout')
      fixture.child.stderr.emit('data', 'late stderr')
      fixture.child.emit('close', 1, null)
      expect(from).not.toHaveBeenCalled()
      expect(decode).not.toHaveBeenCalled()
      expect(fixture.stdoutChunks.at(-1)).toBe('late stdout')
      expect(fixture.stderrChunks.at(-1)).toBe('late stderr')
    }
  )

  it('decodes once when force-kill closes synchronously', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const fixture = fakeCommand(8, controller.signal)
    fixture.child.kill.mockImplementation((signal) => {
      if (signal === 'SIGKILL') {
        fixture.child.emit('close', null, 'SIGKILL')
      }
      return true
    })
    fixture.child.stdout.emit('data', 'before😀')
    const decode = vi.spyOn(Buffer.prototype, 'toString')
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
    expect(decode).toHaveBeenCalledTimes(2)
  })
})
