// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { createPreviewBoxFit } from './preview-terminal-box-fit'

const frames = new Map<number, FrameRequestCallback>()
const cancelFrame = vi.fn((id: number) => frames.delete(id))
let nextFrame = 0
const terminals: Terminal[] = []

beforeEach(() => {
  nextFrame = 0
  frames.clear()
  vi.clearAllMocks()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', cancelFrame)
})

afterEach(() => {
  for (const terminal of terminals.splice(0)) {
    terminal.dispose()
  }
  vi.unstubAllGlobals()
})

function harness(getTerminal?: () => null) {
  const box = document.createElement('div')
  const container = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  box.append(container)
  container.append(screen)
  Object.defineProperties(box, {
    clientWidth: { value: 600 },
    clientHeight: { value: 240 }
  })
  Object.defineProperties(screen, {
    offsetWidth: { value: 800 },
    offsetHeight: { value: 384 }
  })
  const terminal = new Terminal({ rows: 24, cols: 80, allowProposedApi: true })
  terminals.push(terminal)
  const read = vi.fn(getTerminal ?? (() => terminal))
  return { ...createPreviewBoxFit({ container, getTerminal: read }), box, container, read }
}

function flush(id = 0): void {
  const callback = frames.get(id)
  frames.delete(id)
  callback?.(16)
}

function thrown(operation: () => void): unknown {
  try {
    operation()
  } catch (error) {
    return error
  }
  throw new Error('Expected an error')
}

it('keeps live geometry and coalesces repeated requests into one frame', () => {
  const owner = harness()
  owner.schedule()
  owner.schedule()
  owner.schedule()
  expect(owner.read).not.toHaveBeenCalled()
  expect(frames.size).toBe(1)
  flush()
  expect(owner.read).toHaveBeenCalledOnce()
  expect(owner.container.style.transform).toBe('scale(0.75)')
  expect(owner.container.style.transformOrigin).toBe('top left')
  expect(owner.box.style.alignItems).toBe('flex-start')
  owner.dispose()
  expect(cancelFrame).not.toHaveBeenCalled()
})

it('cancels frame zero once and suppresses captured or later callbacks after disposal', () => {
  const owner = harness()
  owner.schedule()
  const captured = frames.get(0)
  owner.dispose()
  owner.dispose()
  captured?.(16)
  owner.schedule()
  expect(owner.read).not.toHaveBeenCalled()
  expect(owner.container.style.transform).toBe('')
  expect(frames.size).toBe(0)
  expect(cancelFrame).toHaveBeenCalledExactlyOnceWith(0)
})

it('preserves synchronous frame completion without canceling a completed handle', () => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(16)
    return 0
  })
  const owner = harness()
  owner.schedule()
  owner.schedule()
  expect(owner.read).toHaveBeenCalledTimes(2)
  owner.dispose()
  expect(cancelFrame).not.toHaveBeenCalled()
})

it('retains a reentrant successor frame and cancels only that pending successor', () => {
  const owner = harness()
  owner.read.mockImplementationOnce(() => {
    owner.schedule()
    return null
  })
  owner.schedule()
  flush()
  expect(owner.read).toHaveBeenCalledOnce()
  expect([...frames.keys()]).toEqual([1])
  owner.dispose()
  expect(cancelFrame).toHaveBeenCalledExactlyOnceWith(1)
})

it('marks disposal before cancellation reenters schedule or invokes the retired callback', () => {
  const owner = harness()
  owner.schedule()
  const callback = frames.get(0)
  cancelFrame.mockImplementationOnce((id) => {
    owner.schedule()
    owner.dispose()
    callback?.(16)
    return frames.delete(id)
  })
  owner.dispose()
  expect(owner.read).not.toHaveBeenCalled()
  expect(frames.size).toBe(0)
  expect(cancelFrame).toHaveBeenCalledExactlyOnceWith(0)
})

it('preserves the original synchronous scheduling error and already-set coalescing flag', () => {
  const error = new Error('scheduler failed')
  const request = vi.fn(() => {
    throw error
  })
  vi.stubGlobal('requestAnimationFrame', request)
  const owner = harness()
  expect(thrown(owner.schedule)).toBe(error)
  owner.schedule()
  expect(request).toHaveBeenCalledOnce()
  owner.dispose()
  expect(cancelFrame).not.toHaveBeenCalled()
})

it('preserves a fit error and allows the next live request after completion', () => {
  const error = new Error('terminal read failed')
  const owner = harness()
  owner.read.mockImplementationOnce(() => {
    throw error
  })
  owner.schedule()
  expect(thrown(() => flush())).toBe(error)
  owner.schedule()
  flush(1)
  expect(owner.read).toHaveBeenCalledTimes(2)
  owner.dispose()
  expect(cancelFrame).not.toHaveBeenCalled()
})

it('does not cancel another owner when both use the same container', () => {
  const old = harness()
  const current = createPreviewBoxFit({ container: old.container, getTerminal: () => null })
  old.schedule()
  current.schedule()
  old.dispose()
  expect([...frames.keys()]).toEqual([1])
  current.dispose()
  expect(cancelFrame.mock.calls).toEqual([[0], [1]])
})
