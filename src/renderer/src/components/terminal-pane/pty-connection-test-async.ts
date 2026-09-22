import { vi } from 'vitest'
import { Terminal } from '@xterm/headless'

// Why: fresh-spawn/reattach now settle across multiple microtasks, so tests must drain several ticks before asserting on IPC mocks. See docs/mobile-prefer-renderer-scrollback.md.
export async function flushAsyncTicks(count = 6): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve()
  }
}

export async function drainFakeTimerWork(limit = 20): Promise<void> {
  await flushAsyncTicks(20)
  if (!vi.isFakeTimers()) {
    return
  }
  for (let iteration = 0; iteration < limit && vi.getTimerCount() > 0; iteration += 1) {
    await vi.runOnlyPendingTimersAsync()
    await flushAsyncTicks(20)
  }
  vi.clearAllTimers()
  await flushAsyncTicks(20)
  vi.clearAllTimers()
}

export async function drainPendingTimeouts(
  pendingTimeouts: (() => void)[],
  limit = 100
): Promise<void> {
  let iterations = 0
  while (pendingTimeouts.length > 0) {
    if (iterations >= limit) {
      throw new Error('Timed out draining pending timeouts')
    }
    iterations += 1
    pendingTimeouts.shift()?.()
    await flushAsyncTicks()
  }
}

export function writeHeadlessTerminal(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

export async function renderHeadlessBuffer(
  writes: string[],
  cols = 80,
  rows = 8
): Promise<string[]> {
  const term = new Terminal({ cols, rows, allowProposedApi: true })
  try {
    for (const write of writes) {
      await writeHeadlessTerminal(term, write)
    }
    const lines: string[] = []
    for (let lineIndex = 0; lineIndex < term.buffer.active.length; lineIndex++) {
      lines.push(term.buffer.active.getLine(lineIndex)?.translateToString(true) ?? '')
    }
    return lines
  } finally {
    term.dispose()
  }
}

export async function renderHeadlessTerminalState(
  writes: string[],
  cols = 80,
  rows = 8
): Promise<{ allLines: string[]; visibleLines: string[]; baseY: number }> {
  const term = new Terminal({ cols, rows, allowProposedApi: true })
  try {
    for (const write of writes) {
      await writeHeadlessTerminal(term, write)
    }
    const allLines: string[] = []
    const buffer = term.buffer.active
    for (let lineIndex = 0; lineIndex < buffer.length; lineIndex++) {
      allLines.push(buffer.getLine(lineIndex)?.translateToString(true) ?? '')
    }
    const visibleLines: string[] = []
    for (let row = 0; row < term.rows; row++) {
      visibleLines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
    }
    return { allLines, visibleLines, baseY: buffer.baseY }
  } finally {
    term.dispose()
  }
}

export function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolveDeferred!: (value: T) => void
  let rejectDeferred!: (reason?: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve
    rejectDeferred = reject
  })
  return { promise, resolve: resolveDeferred, reject: rejectDeferred }
}
