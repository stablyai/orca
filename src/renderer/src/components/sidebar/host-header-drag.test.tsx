// @vitest-environment happy-dom
import React from 'react'
import { act, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useHostHeaderDrag } from './host-header-drag'
import type { ExecutionHostId } from '../../../../shared/execution-host'

function setup() {
  const scrollContainer = document.createElement('div')
  document.body.append(scrollContainer)
  const controller: { current: ReturnType<typeof useHostHeaderDrag> | null } = { current: null }

  function Harness(): React.JSX.Element {
    const drag = useHostHeaderDrag({
      orderedHostIds: ['ssh:host-a', 'ssh:host-b'] as ExecutionHostId[],
      onCommit: vi.fn(),
      getScrollContainer: () => scrollContainer
    })
    controller.current = drag
    return (
      <div
        data-host-header-drag-id="ssh:host-a"
        onPointerDown={(event) => drag.onHandlePointerDown(event, 'ssh:host-a')}
      />
    )
  }

  const view = render(<Harness />)
  const header = view.container.querySelector<HTMLElement>('[data-host-header-drag-id]')!
  header.setPointerCapture = vi.fn()
  header.releasePointerCapture = vi.fn()
  return { controller, header }
}

function pointer(type: string, init: PointerEventInit): PointerEvent {
  return new PointerEvent(type, { bubbles: true, pointerId: 1, ...init })
}

describe('useHostHeaderDrag', () => {
  it('does not start a drag when the pointer is released before the window listeners attach', () => {
    const { controller, header } = setup()

    // A click: pointerdown arms the session, pointerup lands before React has
    // flushed the passive effect that subscribes to window pointer events.
    act(() => {
      header.dispatchEvent(pointer('pointerdown', { button: 0, clientX: 10, clientY: 10 }))
      window.dispatchEvent(pointer('pointerup', { clientX: 10, clientY: 10 }))
    })

    // Moving the mouse afterwards, with no button held, must not promote a drag.
    act(() => {
      window.dispatchEvent(pointer('pointermove', { clientX: 200, clientY: 400, buttons: 0 }))
    })

    expect(controller.current?.state.draggingHostId).toBeNull()
  })

  it('clears a session whose pointerup was missed so a later drag still works', () => {
    const { controller, header } = setup()

    act(() => {
      header.dispatchEvent(pointer('pointerdown', { button: 0, clientX: 10, clientY: 10 }))
      window.dispatchEvent(pointer('pointerup', { clientX: 10, clientY: 10 }))
    })
    act(() => {
      window.dispatchEvent(pointer('pointermove', { clientX: 200, clientY: 400, buttons: 0 }))
    })

    act(() => {
      header.dispatchEvent(pointer('pointerdown', { button: 0, clientX: 10, clientY: 10 }))
    })
    act(() => {
      window.dispatchEvent(pointer('pointermove', { clientX: 40, clientY: 60, buttons: 1 }))
    })

    expect(controller.current?.state.draggingHostId).toBe('ssh:host-a')
  })

  it('still promotes a drag while the pointer stays down', () => {
    const { controller, header } = setup()

    act(() => {
      header.dispatchEvent(pointer('pointerdown', { button: 0, clientX: 10, clientY: 10 }))
    })
    act(() => {
      window.dispatchEvent(pointer('pointermove', { clientX: 40, clientY: 60, buttons: 1 }))
    })

    expect(controller.current?.state.draggingHostId).toBe('ssh:host-a')
  })
})
