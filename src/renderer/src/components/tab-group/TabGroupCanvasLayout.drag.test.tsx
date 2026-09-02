// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../tab-bar/TabBarQuickCommandsButton', () => ({
  TabBarQuickCommandsButton: () => <button type="button">Command</button>
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

import CanvasTerminalCard, { type CanvasTerminalItem } from './CanvasTerminalCard'

function pointerEvent(
  type: string,
  init: { pointerId?: number; clientX?: number; clientY?: number; button?: number }
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId ?? 1 },
    clientX: { value: init.clientX ?? 0 },
    clientY: { value: init.clientY ?? 0 },
    button: { value: init.button ?? 0 }
  })
  return event
}

const terminalItem: CanvasTerminalItem = {
  terminalTabId: 'terminal-1',
  unifiedTabId: 'unified-1',
  groupId: 'group-1',
  label: 'Terminal 1',
  color: null
}

describe('CanvasTerminalCard gestures', () => {
  let container: HTMLDivElement
  let root: Root | null
  const commitBoundsMock = vi.fn()
  const activateMock = vi.fn()

  beforeEach(async () => {
    activateMock.mockClear()
    commitBoundsMock.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <CanvasTerminalCard
          item={terminalItem}
          worktreeId="worktree-1"
          bounds={{ x: 8, y: 8, width: 320, height: 220 }}
          otherBounds={[{ x: 200, y: 8, width: 320, height: 220 }]}
          isFocused={true}
          onActivate={activateMock}
          onCreateTerminal={vi.fn()}
          onClose={vi.fn()}
          onCommitBounds={commitBoundsMock}
        />
      )
    })
  })

  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
  })

  function installPointerCapture(handle: HTMLElement): void {
    const capturedPointers = new Set<number>()
    Object.assign(handle, {
      setPointerCapture: (pointerId: number) => capturedPointers.add(pointerId),
      releasePointerCapture: (pointerId: number) => capturedPointers.delete(pointerId),
      hasPointerCapture: (pointerId: number) => capturedPointers.has(pointerId)
    })
  }

  it('moves with direct style writes and commits a smart non-overlapping drop once', async () => {
    const card = container.querySelector('[data-pane-canvas-terminal-id]') as HTMLElement
    const handle = container.querySelector('[aria-label="Move terminal"]') as HTMLElement
    installPointerCapture(handle)

    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerdown', { clientX: 0, clientY: 0 }))
      handle.dispatchEvent(pointerEvent('pointermove', { clientX: 192, clientY: 0 }))
    })

    expect(activateMock).toHaveBeenCalledWith(terminalItem)
    expect(card.style.left).toBe('200px')
    expect(card.style.top).toBe('8px')
    expect(commitBoundsMock).not.toHaveBeenCalled()

    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerup', { clientX: 192, clientY: 0 }))
    })

    expect(commitBoundsMock).toHaveBeenCalledOnce()
    const committed = commitBoundsMock.mock.calls[0][0]
    expect(committed.x).toBeGreaterThanOrEqual(200)
    expect(committed.y).toBeGreaterThanOrEqual(8)
    expect(committed.x > 200 || committed.y > 8).toBe(true)
  })

  it('enforces minimum dimensions while resizing', async () => {
    const widthHandle = container.querySelector(
      '[aria-label="Resize terminal width"]'
    ) as HTMLElement
    installPointerCapture(widthHandle)

    await act(async () => {
      widthHandle.dispatchEvent(pointerEvent('pointerdown', { clientX: 0 }))
      widthHandle.dispatchEvent(pointerEvent('pointermove', { clientX: -500 }))
      widthHandle.dispatchEvent(pointerEvent('pointerup', { clientX: -500 }))
    })

    expect(commitBoundsMock.mock.calls[0][0].width).toBe(320)
  })

  it('supports keyboard resizing from the accessible edge handles', async () => {
    const widthHandle = container.querySelector(
      '[aria-label="Resize terminal width"]'
    ) as HTMLElement

    await act(async () => {
      widthHandle.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
      )
    })

    expect(commitBoundsMock).toHaveBeenCalledOnce()
    expect(commitBoundsMock.mock.calls[0][0].width).toBe(336)
  })

  it('moves from unused header space without hijacking header controls', async () => {
    const card = container.querySelector('[data-pane-canvas-terminal-id]') as HTMLElement
    const header = container.querySelector('[data-pane-canvas-card-header]') as HTMLElement
    const blank = container.querySelector('span.flex-1') as HTMLElement
    const interactive = container.querySelector('[aria-label="New terminal"]') as HTMLElement
    installPointerCapture(header)

    await act(async () => {
      interactive.dispatchEvent(pointerEvent('pointerdown', { clientX: 10, clientY: 10 }))
    })
    expect(commitBoundsMock).not.toHaveBeenCalled()

    await act(async () => {
      blank.dispatchEvent(pointerEvent('pointerdown', { clientX: 10, clientY: 10 }))
      header.dispatchEvent(pointerEvent('pointermove', { clientX: 10, clientY: 310 }))
      header.dispatchEvent(pointerEvent('pointerup', { clientX: 10, clientY: 310 }))
    })

    expect(card.style.top).toBe('308px')
    expect(commitBoundsMock).toHaveBeenCalledOnce()
  })

  it('resizes from the invisible bottom-right corner', async () => {
    const card = container.querySelector('[data-pane-canvas-terminal-id]') as HTMLElement
    const corner = container.querySelector('[data-pane-canvas-resize-corner]') as HTMLElement
    installPointerCapture(corner)

    await act(async () => {
      corner.dispatchEvent(pointerEvent('pointerdown', { clientX: 0, clientY: 0 }))
      corner.dispatchEvent(pointerEvent('pointermove', { clientX: 96, clientY: 80 }))
      corner.dispatchEvent(pointerEvent('pointerup', { clientX: 96, clientY: 80 }))
    })

    expect(card.style.width).toBe('416px')
    expect(card.style.height).toBe('300px')
  })

  it('exposes the canonical pane body attributes used by terminal overlays and AI Vault drops', () => {
    const body = container.querySelector('[data-terminal-canvas-body-id]')
    expect(body?.getAttribute('data-terminal-canvas-body-id')).toBe('terminal-1')
    expect(body?.getAttribute('data-tab-group-body-id')).toBe('group-1')
    expect(body?.getAttribute('data-worktree-id')).toBe('worktree-1')
  })
})
