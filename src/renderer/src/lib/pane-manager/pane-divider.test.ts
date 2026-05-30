import { describe, expect, it, vi } from 'vitest'
import { applyRootBackground, createDividerFlexFrameScheduler } from './pane-divider'

type MockRoot = HTMLElement & {
  style: CSSStyleDeclaration & {
    background: string
    setProperty: ReturnType<typeof vi.fn<(name: string, value: string) => void>>
    removeProperty: ReturnType<typeof vi.fn<(name: string) => void>>
  }
}

function makeRoot(): MockRoot {
  const style = {
    background: '',
    setProperty: vi.fn<(name: string, value: string) => void>(),
    removeProperty: vi.fn<(name: string) => void>()
  }
  return { style } as unknown as MockRoot
}

describe('createDividerFlexFrameScheduler', () => {
  it('coalesces repeated drag updates into one flex write per animation frame', () => {
    const apply = vi.fn()
    const queuedFrames: FrameRequestCallback[] = []
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback)
      return queuedFrames.length
    })
    const cancelFrame = vi.fn()
    const scheduler = createDividerFlexFrameScheduler({ apply, requestFrame, cancelFrame })

    scheduler.schedule(120, 280)
    scheduler.schedule(140, 260)
    scheduler.schedule(160, 240)

    expect(requestFrame).toHaveBeenCalledTimes(1)
    expect(apply).not.toHaveBeenCalled()

    queuedFrames[0]?.(16)

    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenLastCalledWith(160, 240)
    expect(cancelFrame).not.toHaveBeenCalled()
  })

  it('flushes the latest drag update before final pane refit', () => {
    const apply = vi.fn()
    const requestFrame = vi.fn(() => 7)
    const cancelFrame = vi.fn()
    const scheduler = createDividerFlexFrameScheduler({ apply, requestFrame, cancelFrame })

    scheduler.schedule(120, 280)
    scheduler.schedule(180, 220)
    scheduler.flush()

    expect(cancelFrame).toHaveBeenCalledWith(7)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith(180, 220)
  })
})

describe('applyRootBackground', () => {
  it('exposes the pane background as a CSS variable for xterm gutter fill', () => {
    const root = makeRoot()

    applyRootBackground(root, {
      splitBackground: '#111827',
      paneBackground: '#111827'
    })

    expect(root.style.background).toBe('#111827')
    expect(root.style.setProperty).toHaveBeenCalledWith(
      '--orca-terminal-pane-background',
      '#111827'
    )
  })

  it('clears stale pane background variables when no pane background is present', () => {
    const root = makeRoot()

    applyRootBackground(root, {})

    expect(root.style.removeProperty).toHaveBeenCalledWith('--orca-terminal-pane-background')
  })
})
