import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLIES,
  PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLY_CODE_UNITS,
  TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS,
  createPtyInputWriteQueue
} from './pty-input-write-queue'
import {
  TERMINAL_INPUT_CHUNK_MAX_BYTES,
  TERMINAL_INPUT_MAX_BYTES
} from '../../../../shared/terminal-input'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../../shared/clipboard-text'
import { mode2031SequenceFor } from '../../../../shared/terminal-color-scheme-protocol'
import { PtyStartupIngress, type PtyIngressEmission } from '../../../../shared/pty-startup-ingress'
import {
  extractOnlyCookedEchoSafeQueryReplies,
  needsCookedEchoSafeQueryReply
} from '../../../../shared/terminal-query-reply'
import { installTerminalCapabilityReplyHandlers } from './terminal-capability-replies'

const WHEEL_UP_REPORT = '\x1b[<64;60;20M'

type WriteRecord = { id: string; data: string }

function createRecordingQueue(options: { writable?: () => boolean } = {}): {
  writes: WriteRecord[]
  queue: ReturnType<typeof createPtyInputWriteQueue>
} {
  const writes: WriteRecord[] = []
  const queue = createPtyInputWriteQueue({
    isWritable: () => options.writable?.() ?? true,
    write: (id, data) => writes.push({ id, data })
  })
  return { writes, queue }
}

function createParkedQueue(): {
  writes: WriteRecord[]
  pendingYields: (() => void)[]
  queue: ReturnType<typeof createPtyInputWriteQueue>
} {
  const writes: WriteRecord[] = []
  const pendingYields: (() => void)[] = []
  const queue = createPtyInputWriteQueue({
    isWritable: () => true,
    write: (id, data) => writes.push({ id, data }),
    yieldBetweenWrites: () =>
      new Promise<void>((resolve) => {
        pendingYields.push(resolve)
      })
  })
  return { writes, pendingYields, queue }
}

async function releaseNextWrite(
  writes: WriteRecord[],
  pendingYields: (() => void)[]
): Promise<void> {
  const before = writes.length
  const release = pendingYields.shift()
  expect(release).toBeDefined()
  release?.()
  await Promise.resolve()
  expect(writes.length).toBeGreaterThan(before)
}

function writeTerminal(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

function extractReplyWrites(writes: WriteRecord[]): string[] {
  return writes.flatMap((write) => extractOnlyCookedEchoSafeQueryReplies(write.data) ?? [])
}

describe('pty input write queue', () => {
  it('coalesces a dense burst of wheel reports instead of one write per macrotask turn', async () => {
    const { writes, queue } = createRecordingQueue()

    // Simulates a 2s aggressive trackpad gesture at 120Hz: 240 SGR reports
    // enqueued while the drain cannot run between events.
    for (let i = 0; i < 240; i += 1) {
      expect(queue.enqueue('pty-1', WHEEL_UP_REPORT)).toBe(true)
    }
    await queue.waitForDrain()

    // First report flushes immediately (keystroke latency); everything queued
    // behind it must drain as a single coalesced write, not 239 timer turns.
    expect(writes.length).toBe(2)
    expect(writes[0]?.data).toBe(WHEEL_UP_REPORT)
    expect(writes[1]?.data).toBe(WHEEL_UP_REPORT.repeat(239))
    expect(writes.map((write) => write.id)).toEqual(['pty-1', 'pty-1'])
  })

  it('preserves byte order and content across coalesced writes', async () => {
    const { writes, queue } = createRecordingQueue()

    const inputs = ['a', '\x1b[<65;1;1M', 'bc', '\x1b[A', 'd']
    for (const input of inputs) {
      queue.enqueue('pty-1', input)
    }
    await queue.waitForDrain()

    expect(writes.map((write) => write.data).join('')).toBe(inputs.join(''))
  })

  it('does not coalesce across different PTY ids', async () => {
    const writes: WriteRecord[] = []
    const queue = createPtyInputWriteQueue({
      isWritable: () => true,
      write: (id, data) => writes.push({ id, data })
    })

    queue.enqueue('pty-1', 'a')
    queue.enqueue('pty-1', 'b')
    queue.enqueue('pty-2', 'c')
    queue.enqueue('pty-1', 'd')
    await queue.waitForDrain()

    expect(writes).toEqual([
      { id: 'pty-1', data: 'a' },
      { id: 'pty-1', data: 'b' },
      { id: 'pty-2', data: 'c' },
      { id: 'pty-1', data: 'd' }
    ])
  })

  it('keeps coalesced payloads under the input chunk byte cap', async () => {
    const { writes, queue } = createRecordingQueue()

    const piece = 'x'.repeat(1000)
    for (let i = 0; i < 12; i += 1) {
      queue.enqueue('pty-1', piece)
    }
    await queue.waitForDrain()

    expect(writes.map((write) => write.data).join('')).toBe(piece.repeat(12))
    for (const write of writes) {
      expect(write.data.length).toBeLessThanOrEqual(TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS)
    }
    expect(writes.length).toBeGreaterThan(1)
  })

  it('still chunks oversized items and keeps trailing input ordered behind them', async () => {
    const { writes, queue } = createRecordingQueue()

    const large = 'y'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES * 2 + 100)
    queue.enqueue('pty-1', 'before')
    queue.enqueue('pty-1', large)
    queue.enqueue('pty-1', 'after')
    await queue.waitForDrain()

    expect(writes.map((write) => write.data).join('')).toBe(`before${large}after`)
    expect(writes.at(-1)?.data).toBe('after')
    for (const write of writes) {
      expect(write.data.length).toBeLessThanOrEqual(TERMINAL_INPUT_CHUNK_MAX_BYTES)
    }
  })

  it('rejects input over the terminal input byte limit without writing', async () => {
    const { writes, queue } = createRecordingQueue()

    expect(queue.enqueue('pty-1', 'z'.repeat(TERMINAL_INPUT_MAX_BYTES + 1))).toBe(false)
    await queue.waitForDrain()

    expect(writes).toEqual([])
  })

  it('drops queued input for PTYs that are no longer writable', async () => {
    let writable = true
    const { writes, queue } = createRecordingQueue({ writable: () => writable })

    queue.enqueue('pty-1', 'a')
    writable = false
    queue.enqueue('pty-1', 'b')
    await queue.waitForDrain()

    expect(writes).toEqual([{ id: 'pty-1', data: 'a' }])
  })

  it('does not coalesce dual color-scheme replies into one host write (#13137)', async () => {
    const { writes, queue } = createRecordingQueue()
    const reply = mode2031SequenceFor('dark')

    expect(queue.enqueueQueryReply('pty-1', reply)).toBe(true)
    expect(queue.enqueueQueryReply('pty-1', reply)).toBe(true)
    await queue.waitForDrain()

    expect(writes).toEqual([
      { id: 'pty-1', data: reply },
      { id: 'pty-1', data: reply }
    ])
  })

  it('keeps all query replies atomic for host-side ordering (#13892)', async () => {
    const { writes, queue } = createRecordingQueue()
    const replies = ['\x1b[?1;2c', '\x1b[1;1R']

    for (const reply of replies) {
      expect(queue.enqueueQueryReply('pty-1', reply)).toBe(true)
    }
    await queue.waitForDrain()

    expect(writes.map((write) => write.data)).toEqual(replies)
  })

  it('does not coalesce a color-scheme reply with a following keystroke', async () => {
    const { writes, queue } = createRecordingQueue()
    const reply = mode2031SequenceFor('dark')

    queue.enqueueQueryReply('pty-1', reply)
    queue.enqueue('pty-1', 'y')
    await queue.waitForDrain()

    expect(writes).toEqual([
      { id: 'pty-1', data: reply },
      { id: 'pty-1', data: 'y' }
    ])
  })

  it('bounds an OSC 10/11 reply flood and drains a following keystroke', async () => {
    const { writes, pendingYields, queue } = createParkedQueue()
    const replies: string[] = []
    let allAccepted = true

    for (let index = 0; index < 10_000; index += 1) {
      const color = index.toString(16).padStart(4, '0')
      const reply = `\x1b]${index % 2 === 0 ? 10 : 11};rgb:${color}/0000/0000\x1b\\`
      replies.push(reply)
      allAccepted = queue.enqueueQueryReply('pty-1', reply) && allAccepted
    }
    expect(allAccepted).toBe(true)
    expect(queue.enqueue('pty-1', 'k')).toBe(true)

    await Promise.resolve()
    expect(pendingYields).toHaveLength(1)
    for (let turn = 0; turn < PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLIES; turn += 1) {
      await releaseNextWrite(writes, pendingYields)
    }
    await queue.waitForDrain()

    const replyWrites = writes.filter((write) => write.data.startsWith('\x1b]'))
    expect(replyWrites.map((write) => write.data)).toEqual([
      replies[0],
      ...replies.slice(-PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLIES)
    ])
    expect(replyWrites.every((write) => needsCookedEchoSafeQueryReply(write.data))).toBe(true)
    expect(writes.at(-1)?.data).toBe('k')
  })

  it('applies the same bound to DA1 replies kept atomic for ordering', async () => {
    const { writes, pendingYields, queue } = createParkedQueue()
    const replies = Array.from({ length: 10_000 }, (_, index) => `\x1b[?${index};2c`)

    for (const reply of replies) {
      expect(queue.enqueueQueryReply('pty-1', reply)).toBe(true)
    }
    expect(queue.enqueue('pty-1', 'k')).toBe(true)

    await Promise.resolve()
    for (let turn = 0; turn < PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLIES; turn += 1) {
      await releaseNextWrite(writes, pendingYields)
    }
    await queue.waitForDrain()

    expect(writes.map((write) => write.data)).toEqual([
      replies[0],
      ...replies.slice(-PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLIES),
      'k'
    ])
  })

  it('drops the oldest reply-only payload when the reply text budget fills', async () => {
    const reply = (slot: 10 | 11, marker: string): string =>
      `\x1b]${slot};${marker.repeat(1_400)}\x1b\\`
    const first = reply(10, '1')
    const dropped = reply(11, '2')
    const second = reply(10, '3')
    const third = reply(11, '4')
    const { writes, pendingYields, queue } = createParkedQueue()

    expect(second.length * 2).toBeLessThanOrEqual(
      PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLY_CODE_UNITS
    )
    expect(second.length * 3).toBeGreaterThan(PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLY_CODE_UNITS)
    queue.enqueueQueryReply('pty-1', first)
    queue.enqueueQueryReply('pty-1', dropped)
    queue.enqueue('pty-1', 'x')
    queue.enqueueQueryReply('pty-1', second)
    queue.enqueueQueryReply('pty-1', third)
    queue.enqueue('pty-1', 'k')

    await Promise.resolve()
    expect(pendingYields).toHaveLength(1)
    for (let turn = 0; turn < 3; turn += 1) {
      await releaseNextWrite(writes, pendingYields)
    }
    await queue.waitForDrain()

    expect(writes).toEqual([
      { id: 'pty-1', data: first },
      { id: 'pty-1', data: 'x' },
      { id: 'pty-1', data: second },
      { id: 'pty-1', data: third },
      { id: 'pty-1', data: 'k' }
    ])
  })

  it('bounds replies generated by a real xterm OSC query flood', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    term.options.theme = { foreground: '#2e3434', background: '#ffffff' }
    const { writes, queue } = createRecordingQueue()
    const generated: string[] = []
    const disposable = installTerminalCapabilityReplyHandlers({
      terminal: {
        cols: term.cols,
        rows: term.rows,
        element: undefined,
        options: term.options
      },
      parser: term.parser,
      sendInput: (data) => {
        generated.push(data)
        return queue.enqueueQueryReply('pty-1', data)
      },
      isReplaying: () => false
    })

    try {
      await writeTerminal(term, '\x1b]10;?;?\x1b\\'.repeat(34))
      await queue.waitForDrain()

      const foreground = '\x1b]10;rgb:2e2e/3434/3434\x1b\\'
      const background = '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'
      expect(generated).toEqual(Array.from({ length: 34 }, () => [foreground, background]).flat())
      expect(extractReplyWrites(writes)).toEqual([
        foreground,
        ...generated.slice(-PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLIES)
      ])
    } finally {
      disposable.dispose()
      term.dispose()
    }
  })

  it('rejects one reply larger than the total reply retention budget', async () => {
    const { writes, queue } = createRecordingQueue()
    const prefix = '\x1b]10;'
    const suffix = '\x1b\\'
    const input = `${prefix}${'x'.repeat(
      TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS + 1 - prefix.length - suffix.length
    )}${suffix}`

    expect(input).toHaveLength(TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS + 1)
    expect(queue.enqueueQueryReply('pty-1', input)).toBe(false)
    await queue.waitForDrain()

    expect(writes).toEqual([])
  })

  it('preserves an ordinary backlog while bounding later replies', async () => {
    const { writes, queue } = createRecordingQueue()
    const ordinary = Array.from({ length: 10_000 }, (_, index) => String(index % 10))
    const replies = Array.from({ length: 10_000 }, (_, index) => `\x1b[?${index};1n`)

    for (const input of ordinary) {
      expect(queue.enqueue('pty-1', input)).toBe(true)
    }
    for (const reply of replies) {
      expect(queue.enqueueQueryReply('pty-1', reply)).toBe(true)
    }
    await queue.waitForDrain()

    expect(writes.map((write) => write.data).join('')).toBe(
      [...ordinary, ...replies.slice(-PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLIES)].join('')
    )
    expect(extractReplyWrites(writes)).toEqual(
      replies.slice(-PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLIES)
    )
  })

  it('never sheds reply-shaped bytes sent through the ordinary input path', async () => {
    const { writes, queue } = createRecordingQueue()
    const ordinary = '\x1b]10;user-ordinary-marker\x1b\\'
    const replies = Array.from({ length: 10_000 }, (_, index) => `\x1b[?${index};1n`)

    expect(queue.enqueueQueryReply('pty-1', '\x1b[?10000;1n')).toBe(true)
    expect(queue.enqueue('pty-1', ordinary)).toBe(true)
    for (const reply of replies) {
      expect(queue.enqueueQueryReply('pty-1', reply)).toBe(true)
    }
    await queue.waitForDrain()

    expect(writes.map((write) => write.data).join('')).toContain(ordinary)
  })

  it('contains drain failures and rejects input until queue reuse', async () => {
    const failure = new Error('write failed')
    const writes: WriteRecord[] = []
    let shouldThrow = true
    const onDrainFailure = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const queue = createPtyInputWriteQueue({
      isWritable: () => true,
      write: (id, data) => {
        if (shouldThrow) {
          throw failure
        }
        writes.push({ id, data })
      },
      onDrainFailure
    })

    try {
      expect(queue.enqueue('pty-1', 'stale')).toBe(true)
      expect(queue.enqueue('pty-1', 'also-stale')).toBe(false)
      await expect(queue.waitForDrain()).resolves.toBeUndefined()

      shouldThrow = false
      expect(queue.enqueue('pty-1', 'still-stale')).toBe(false)
      queue.clear()
      expect(queue.enqueue('pty-1', 'fresh')).toBe(true)
      await queue.waitForDrain()

      expect(writes).toEqual([{ id: 'pty-1', data: 'fresh' }])
      expect(warn).toHaveBeenCalledWith('[pty-input-write-queue] drain failed:', failure)
      expect(onDrainFailure).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  it('reports the pty id that failed so a rebound owner can ignore the drain failure', async () => {
    const failure = new Error('yield failed')
    const onDrainFailure = vi.fn()
    let rejectYield: ((error: Error) => void) | undefined
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const queue = createPtyInputWriteQueue({
      isWritable: () => true,
      write: () => undefined,
      yieldBetweenWrites: () =>
        new Promise<void>((_resolve, reject) => {
          rejectYield = reject
        }),
      onDrainFailure
    })

    try {
      expect(queue.enqueue('pty-1', 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES * 2))).toBe(true)
      expect(rejectYield).toBeDefined()
      rejectYield?.(failure)
      await queue.waitForDrain()

      expect(onDrainFailure).toHaveBeenCalledExactlyOnceWith('pty-1')
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps a pending reply small enough that one drain step writes and removes it', () => {
    // Larger replies would span chunks, so admitReply could evict a half-written entry.
    expect(PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLY_CODE_UNITS * 3).toBeLessThanOrEqual(
      TERMINAL_INPUT_CHUNK_MAX_BYTES
    )
  })

  it('does not let a stale drain failure clear input queued after reuse', async () => {
    const failure = new Error('stale yield failed')
    const writes: WriteRecord[] = []
    let rejectYield: ((error: Error) => void) | undefined
    let rejectNextYield = true
    const onDrainFailure = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const queue = createPtyInputWriteQueue({
      isWritable: () => true,
      write: (id, data) => writes.push({ id, data }),
      yieldBetweenWrites: () => {
        if (!rejectNextYield) {
          return Promise.resolve()
        }
        return new Promise<void>((_resolve, reject) => {
          rejectYield = reject
        })
      },
      onDrainFailure
    })

    try {
      expect(queue.enqueue('pty-1', 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES * 2))).toBe(true)
      expect(rejectYield).toBeDefined()
      queue.clear()
      rejectNextYield = false
      expect(queue.enqueue('pty-2', 'fresh')).toBe(true)
      rejectYield?.(failure)
      await queue.waitForDrain()

      expect(writes.at(-1)).toEqual({ id: 'pty-2', data: 'fresh' })
      expect(warn).toHaveBeenCalledWith('[pty-input-write-queue] drain failed:', failure)
      expect(onDrainFailure).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('dual mode-2031 enqueues through the real queue never paint 997 under host echo-safe write', async () => {
    // Two 997s can still coalesce in one write: a fast theme flip, or an old client that
    // still answers 2031 subscribes (#9993 made this host silent, mixed versions have not).
    // Drive the real write queue → host intercept (extract + answerLiveQueryReply)
    // → ingress echo strip, and assert no `997;1n` emission at the confirm prompt.
    vi.useFakeTimers()
    const reply = mode2031SequenceFor('dark')
    // ECHOCTL carets every control, not just ESC. Identical for this reply (it carries no
    // other control), but modelled correctly so this does not drift from the encoder.
    const caretEcho = (data: string): string =>
      [...data]
        .map((ch) =>
          ch.charCodeAt(0) < 0x20 ? `^${String.fromCharCode(ch.charCodeAt(0) + 0x40)}` : ch
        )
        .join('')
    const masterWrites: string[] = []
    const emissions: PtyIngressEmission[] = []
    let ingress!: PtyStartupIngress
    ingress = new PtyStartupIngress({
      ownerBackend: 'posix-pty',
      write: (data) => {
        masterWrites.push(data)
        ingress.accept(caretEcho(data))
      },
      onEmission: (emission) => emissions.push(emission)
    })

    // Same intercept shape as LocalPtyProvider.write / Session.write / relay writeData.
    const hostWrite = (_id: string, data: string): void => {
      if (ingress.answerLiveQueryReply(data)) {
        return
      }
      masterWrites.push(`RAW:${data}`)
      ingress.accept(caretEcho(data))
    }

    const queue = createPtyInputWriteQueue({
      isWritable: () => true,
      write: hostWrite
    })

    expect(queue.enqueueQueryReply('pty-1', reply)).toBe(true)
    expect(queue.enqueueQueryReply('pty-1', reply)).toBe(true)
    await queue.waitForDrain()
    await vi.advanceTimersByTimeAsync(0)

    expect(masterWrites).toEqual([reply, reply])
    expect(masterWrites.some((write) => write.startsWith('RAW:'))).toBe(false)
    const visible = emissions.map((emission) => emission.data).join('')
    expect(visible).toBe('')
    expect(visible).not.toContain('997')

    ingress.accept('Ok to proceed? (y) ')
    const afterPrompt = emissions.map((emission) => emission.data).join('')
    expect(afterPrompt).toBe('Ok to proceed? (y) ')
    expect(afterPrompt).not.toContain('997;1n')
    expect(afterPrompt).not.toContain(reply)
    ingress.drainAndClose()
    vi.useRealTimers()
  })

  it('clear() drops pending input that has not been written yet', async () => {
    const writes: WriteRecord[] = []
    const pendingYields: (() => void)[] = []
    const queue = createPtyInputWriteQueue({
      isWritable: () => true,
      write: (id, data) => writes.push({ id, data }),
      yieldBetweenWrites: () =>
        new Promise<void>((resolve) => {
          pendingYields.push(resolve)
        })
    })

    const large = 'y'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES * 3)
    queue.enqueue('pty-1', large)
    queue.enqueue('pty-1', 'tail')
    // First chunk is written synchronously, then the drain parks on the yield.
    expect(writes.length).toBe(1)

    queue.clear()
    pendingYields.shift()?.()
    await queue.waitForDrain()

    expect(writes.length).toBe(1)
    expect(writes.map((write) => write.data).join('')).not.toContain('tail')
  })

  it('clear() fences an in-flight validation before queue reuse', async () => {
    vi.useFakeTimers()
    const { writes, queue } = createRecordingQueue()
    const stale = 'é'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)

    try {
      expect(queue.enqueue('pty-1', stale)).toBe(true)
      queue.clear()
      expect(queue.enqueue('pty-1', 'fresh')).toBe(true)

      await vi.runAllTimersAsync()
      await queue.waitForDrain()

      expect(writes).toEqual([{ id: 'pty-1', data: 'fresh' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('clear() resets reply capacity for later input', async () => {
    const { writes, queue } = createRecordingQueue()
    const reply = mode2031SequenceFor('dark')

    for (let index = 0; index <= PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLIES; index += 1) {
      expect(queue.enqueueQueryReply('pty-1', reply)).toBe(true)
    }
    queue.clear()
    expect(queue.enqueueQueryReply('pty-1', reply)).toBe(true)
    await queue.waitForDrain()

    expect(extractReplyWrites(writes)).toEqual([reply, reply])
  })
})
