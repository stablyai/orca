import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runRecipeCommand } from './ephemeral-vm-recipe-process'
import { GrowingByteBuffer } from '@orca/process-host/growing-byte-buffer'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** The pre-ring policy: re-encode the retained tail on every chunk and trim to a character boundary. */

/** What the capture now retains: the last maxBytes raw bytes, minus a leading partial sequence. */
function rawByteTail(bytes: Buffer, maxBytes: number): string {
  let start = Math.max(0, bytes.byteLength - maxBytes)
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) {
    start += 1
  }
  return bytes.toString('utf8', start)
}

/** Independent oracle: keep whole code points from the end until the byte limit is reached. */

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

/** Count only our buffer’s moves; global Buffer spies capture unrelated same-tick allocations and destabilize budgets. */
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
  it('does not restore bytes discarded at an earlier chunk boundary', async () => {
    const fixture = fakeCommand(5)
    for (const chunk of ['😀', 'ab', 'c']) {
      fixture.child.stdout.emit('data', Buffer.from(chunk, 'utf8'))
    }
    fixture.child.emit('close', 0, null)
    await expect(fixture.result).resolves.toMatchObject({ stdout: 'abc' })
  })

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
    // Keep raw tail bytes instead of re-encoded replacement characters, retaining more actual malformed output.
    expect(result).toEqual({
      stdout: rawByteTail(Buffer.concat([stdoutBytes, malformed]), 9),
      stderr: rawByteTail(stderrBytes, 9),
      exitCode: 17,
      signal: null
    })
    expect(result.stdout).toBe(':end��(�')
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
})
