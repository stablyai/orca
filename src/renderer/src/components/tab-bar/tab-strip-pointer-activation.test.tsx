/**
 * @vitest-environment happy-dom
 */
import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TabDragProvider } from '../tab-group/tab-drag-context'
import { useTabStripPointerActivation } from './tab-strip-pointer-activation'

function Probe({ onActivate }: { onActivate: () => void }): React.JSX.Element {
  const [dragActive, setDragActive] = useState(false)
  const dragActiveRef = useRef(false)
  dragActiveRef.current = dragActive

  return (
    <TabDragProvider isTabDragActive={dragActive} isTabDragActiveRef={dragActiveRef}>
      <ProbeButton onActivate={onActivate} onDragActiveChange={setDragActive} />
    </TabDragProvider>
  )
}

function ProbeButton({
  onActivate,
  onDragActiveChange
}: {
  onActivate: () => void
  onDragActiveChange: (active: boolean) => void
}): React.JSX.Element {
  const { isPressed, onPointerDown } = useTabStripPointerActivation({ onActivate })
  return (
    <>
      <button
        type="button"
        data-pressed={isPressed ? 'true' : 'false'}
        onPointerDown={(event) => onPointerDown(event)}
      >
        Tab
      </button>
      <button type="button" onClick={() => onDragActiveChange(true)}>
        Start drag
      </button>
    </>
  )
}

let root: Root | null = null
let container: HTMLDivElement | null = null

function renderProbe(onActivate = vi.fn()): {
  onActivate: ReturnType<typeof vi.fn>
  tabButton: HTMLButtonElement
  dragButton: HTMLButtonElement
} {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<Probe onActivate={onActivate} />)
  })
  const buttons = container.querySelectorAll('button')
  return {
    onActivate,
    tabButton: buttons[0] as HTMLButtonElement,
    dragButton: buttons[1] as HTMLButtonElement
  }
}

function dispatchPointer(target: EventTarget, type: string): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }))
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('useTabStripPointerActivation', () => {
  it('defers activation until pointerup', () => {
    const { onActivate, tabButton } = renderProbe()

    act(() => dispatchPointer(tabButton, 'pointerdown'))
    expect(tabButton.dataset.pressed).toBe('true')
    expect(onActivate).not.toHaveBeenCalled()

    act(() => dispatchPointer(window, 'pointerup'))
    expect(tabButton.dataset.pressed).toBe('false')
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('cancels pending activation on pointercancel', () => {
    const { onActivate, tabButton } = renderProbe()

    act(() => dispatchPointer(tabButton, 'pointerdown'))
    act(() => dispatchPointer(window, 'pointercancel'))

    expect(tabButton.dataset.pressed).toBe('false')
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('clears pending activation when a drag starts', () => {
    const { onActivate, tabButton, dragButton } = renderProbe()

    act(() => dispatchPointer(tabButton, 'pointerdown'))
    act(() => dragButton.click())
    act(() => dispatchPointer(window, 'pointerup'))

    expect(tabButton.dataset.pressed).toBe('false')
    expect(onActivate).not.toHaveBeenCalled()
  })
})
