// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleSwitchTabAcrossAllTypes } from './ipc-tab-switch'
import { useMouseTabNavigation } from './useMouseTabNavigation'

vi.mock('./ipc-tab-switch', () => ({
  handleSwitchTabAcrossAllTypes: vi.fn()
}))

const handleSwitchTabAcrossAllTypesMock = vi.mocked(handleSwitchTabAcrossAllTypes)

let root: Root | null = null
let container: HTMLDivElement | null = null

function Probe(): null {
  useMouseTabNavigation()
  return null
}

async function renderProbe(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<Probe />)
  })
}

function dispatchMouseDown(button: number, overrides: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
    button,
    ...overrides
  })
  window.dispatchEvent(event)
  return event
}

function dispatchAuxClick(button: number): MouseEvent {
  const event = new MouseEvent('auxclick', {
    bubbles: true,
    cancelable: true,
    button
  })
  window.dispatchEvent(event)
  return event
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount()
    })
  }
  root = null
  container?.remove()
  container = null
  vi.clearAllMocks()
})

describe('useMouseTabNavigation', () => {
  it('maps Mouse4 and Mouse5 mousedown gestures to previous and next tab navigation', async () => {
    await renderProbe()

    const backEvent = dispatchMouseDown(3)
    const forwardEvent = dispatchMouseDown(4)

    expect(backEvent.defaultPrevented).toBe(true)
    expect(forwardEvent.defaultPrevented).toBe(true)
    expect(handleSwitchTabAcrossAllTypesMock).toHaveBeenNthCalledWith(1, -1)
    expect(handleSwitchTabAcrossAllTypesMock).toHaveBeenNthCalledWith(2, 1)
  })

  it('consumes side-button auxclick without switching tabs a second time', async () => {
    await renderProbe()

    const event = dispatchAuxClick(3)

    expect(event.defaultPrevented).toBe(true)
    expect(handleSwitchTabAcrossAllTypesMock).not.toHaveBeenCalled()
  })

  it('ignores modified side-button gestures and regular mouse buttons', async () => {
    await renderProbe()

    const modified = dispatchMouseDown(3, { shiftKey: true })
    const primary = dispatchMouseDown(0)

    expect(modified.defaultPrevented).toBe(false)
    expect(primary.defaultPrevented).toBe(false)
    expect(handleSwitchTabAcrossAllTypesMock).not.toHaveBeenCalled()
  })

  it('removes listeners on unmount', async () => {
    await renderProbe()
    await act(async () => {
      root?.unmount()
    })
    root = null

    const event = dispatchMouseDown(3)

    expect(event.defaultPrevented).toBe(false)
    expect(handleSwitchTabAcrossAllTypesMock).not.toHaveBeenCalled()
  })
})
