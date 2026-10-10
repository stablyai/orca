// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { forceRepaintThroughRenderPause } from '../terminal-render-pause-release'
import {
  createNativeTerminalRenderPause,
  isXtermPausedUnderNativeView
} from './native-terminal-render-pause'

type FakeTerminal = {
  element: HTMLElement
  rows: number
  refresh: ReturnType<typeof vi.fn>
  onRender: (listener: () => void) => { dispose: () => void }
  render: () => void
}

function fakeTerminal(): FakeTerminal {
  const element = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  element.appendChild(screen)
  const listeners = new Set<() => void>()
  return {
    element,
    rows: 24,
    refresh: vi.fn(),
    onRender: (listener) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    render: () => {
      for (const listener of listeners) {
        listener()
      }
    }
  }
}

function asTerminal(fake: FakeTerminal): Terminal {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pause only touches element, rows, refresh and onRender, which the fake implements.
  return fake as unknown as Terminal
}

function screenTransform(fake: FakeTerminal): string {
  return fake.element.querySelector<HTMLElement>('.xterm-screen')?.style.transform ?? ''
}

describe('createNativeTerminalRenderPause', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('moves the screen out of view only after the native view had time to present', () => {
    const fake = fakeTerminal()
    const pause = createNativeTerminalRenderPause(asTerminal(fake))
    pause.pause()
    expect(screenTransform(fake)).toBe('')
    expect(pause.isStale()).toBe(false)
    vi.advanceTimersByTime(200)
    expect(screenTransform(fake)).not.toBe('')
    expect(pause.isStale()).toBe(true)
  })

  it('stays stale until xterm repaints after a resume', () => {
    const fake = fakeTerminal()
    const pause = createNativeTerminalRenderPause(asTerminal(fake))
    pause.pause()
    vi.advanceTimersByTime(200)
    const onRepainted = vi.fn()
    pause.resume(onRepainted)
    expect(screenTransform(fake)).toBe('')
    expect(fake.refresh).toHaveBeenCalledWith(0, 23)
    expect(pause.isStale()).toBe(true)
    fake.render()
    expect(pause.isStale()).toBe(false)
    expect(onRepainted).toHaveBeenCalledTimes(1)
  })

  it('gives up waiting on a repaint that never comes', () => {
    const fake = fakeTerminal()
    const pause = createNativeTerminalRenderPause(asTerminal(fake))
    pause.pause()
    vi.advanceTimersByTime(200)
    const onRepainted = vi.fn()
    pause.resume(onRepainted)
    vi.advanceTimersByTime(250)
    expect(pause.isStale()).toBe(false)
    expect(onRepainted).toHaveBeenCalledTimes(1)
  })

  it('never pauses when the native view hides before the delay', () => {
    const fake = fakeTerminal()
    const pause = createNativeTerminalRenderPause(asTerminal(fake))
    pause.pause()
    const onRepainted = vi.fn()
    pause.resume(onRepainted)
    vi.advanceTimersByTime(1000)
    expect(screenTransform(fake)).toBe('')
    expect(pause.isStale()).toBe(false)
    expect(fake.refresh).not.toHaveBeenCalled()
    expect(onRepainted).not.toHaveBeenCalled()
  })

  it('keeps Orca’s forced presents from un-pausing xterm under the native view', () => {
    const fake = fakeTerminal()
    const renderService = { _isPaused: true, _needsFullRefresh: false, refreshRows: vi.fn() }
    const terminal = Object.assign(fake, { _core: { _renderService: renderService } })
    const pause = createNativeTerminalRenderPause(asTerminal(terminal))
    pause.pause()
    vi.advanceTimersByTime(200)
    expect(isXtermPausedUnderNativeView(terminal)).toBe(true)
    expect(forceRepaintThroughRenderPause(terminal)).toBe(false)
    expect(renderService._isPaused).toBe(true)
    pause.resume(vi.fn())
    expect(isXtermPausedUnderNativeView(terminal)).toBe(false)
    expect(forceRepaintThroughRenderPause(terminal)).toBe(true)
  })

  it('follows the native view: pauses when shown, repaints then calls back before a hide', () => {
    const fake = fakeTerminal()
    const afterRepaint = vi.fn()
    const pause = createNativeTerminalRenderPause(asTerminal(fake), afterRepaint)
    pause.setShown(true)
    vi.advanceTimersByTime(200)
    expect(pause.isStale()).toBe(true)
    pause.setShown(false)
    fake.render()
    expect(afterRepaint).toHaveBeenCalledTimes(1)
    expect(pause.isStale()).toBe(false)
  })

  it('restores the screen on dispose', () => {
    const fake = fakeTerminal()
    const pause = createNativeTerminalRenderPause(asTerminal(fake))
    pause.pause()
    vi.advanceTimersByTime(200)
    pause.dispose()
    expect(screenTransform(fake)).toBe('')
    expect(pause.isStale()).toBe(false)
  })
})
