/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalJumpToBottomButton } from './TerminalJumpToBottomButton'

const mocks = vi.hoisted(() => ({
  followTerminalOutput: vi.fn()
}))

vi.mock('./terminal-auto-scroll', () => ({
  followTerminalOutput: mocks.followTerminalOutput
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => children,
  TooltipContent: ({ children }: { children?: ReactNode }) => <span>{children}</span>
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

type TerminalHarness = {
  terminal: Terminal
  fireScroll: () => void
  fireWriteParsed: () => void
  setViewportY: (viewportY: number) => void
  scrollDisposable: { dispose: ReturnType<typeof vi.fn> }
  writeDisposable: { dispose: ReturnType<typeof vi.fn> }
}

const mounted: { container: HTMLDivElement; root: Root }[] = []
let frameCallbacks: Map<number, FrameRequestCallback>
let nextFrameId: number

function createTerminal(viewportY: number, baseY: number): TerminalHarness {
  let scrollListener: (() => void) | null = null
  let writeParsedListener: (() => void) | null = null
  const scrollDisposable = { dispose: vi.fn() }
  const writeDisposable = { dispose: vi.fn() }
  const activeBuffer = { type: 'normal', viewportY, baseY }
  const terminal = {
    buffer: { active: activeBuffer },
    onScroll: vi.fn((listener: () => void) => {
      scrollListener = listener
      return scrollDisposable
    }),
    onWriteParsed: vi.fn((listener: () => void) => {
      writeParsedListener = listener
      return writeDisposable
    })
  } as unknown as Terminal
  return {
    terminal,
    fireScroll: () => scrollListener?.(),
    fireWriteParsed: () => writeParsedListener?.(),
    setViewportY: (nextViewportY) => {
      activeBuffer.viewportY = nextViewportY
    },
    scrollDisposable,
    writeDisposable
  }
}

function renderButton(terminal: Terminal): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<TerminalJumpToBottomButton terminal={terminal} />))
  mounted.push({ container, root })
  return container
}

function flushFrame(): void {
  const pending = [...frameCallbacks.entries()]
  frameCallbacks.clear()
  act(() => {
    for (const [, callback] of pending) {
      callback(16)
    }
  })
}

describe('TerminalJumpToBottomButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    frameCallbacks = new Map()
    nextFrameId = 1
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const frameId = nextFrameId++
        frameCallbacks.set(frameId, callback)
        return frameId
      })
    )
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((frameId: number) => frameCallbacks.delete(frameId))
    )
  })

  afterEach(() => {
    for (const { container, root } of mounted.splice(0)) {
      act(() => root.unmount())
      container.remove()
    }
    vi.unstubAllGlobals()
  })

  it('shows only away from bottom and coalesces scroll and parsed updates into one frame', () => {
    const harness = createTerminal(100, 100)
    const container = renderButton(harness.terminal)
    expect(container.querySelector('button')).toBeNull()

    harness.setViewportY(70)
    act(() => {
      harness.fireScroll()
      harness.fireWriteParsed()
    })

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
    flushFrame()
    expect(container.querySelector('button[aria-label="Jump to bottom"]')).not.toBeNull()

    harness.setViewportY(100)
    act(() => harness.fireWriteParsed())
    flushFrame()
    expect(container.querySelector('button')).toBeNull()
  })

  it('follows output and restores terminal focus when clicked', () => {
    const harness = createTerminal(40, 100)
    const container = renderButton(harness.terminal)
    const button = container.querySelector<HTMLButtonElement>('button')

    expect(button).not.toBeNull()
    act(() => button?.click())

    expect(mocks.followTerminalOutput).toHaveBeenCalledWith(harness.terminal, { focus: true })
  })

  it('cancels pending reads and disposes both xterm subscriptions on unmount', () => {
    const harness = createTerminal(40, 100)
    renderButton(harness.terminal)
    act(() => harness.fireScroll())

    const mountedEntry = mounted.pop()
    expect(mountedEntry).toBeDefined()
    act(() => mountedEntry?.root.unmount())
    mountedEntry?.container.remove()

    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1)
    expect(harness.scrollDisposable.dispose).toHaveBeenCalledTimes(1)
    expect(harness.writeDisposable.dispose).toHaveBeenCalledTimes(1)
  })
})
