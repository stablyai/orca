// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useTabStripPointerActivation } from './tab-strip-pointer-activation'
import {
  beginAgentInputFocusGuard,
  clearAgentInputFocusGuards,
  endAgentInputFocusGuard
} from '../browser-pane/host-guest/input/agent-input-focus-guard'
import { webviewRegistry } from '../browser-pane/host-guest/webview-registry'

function pointerDownEvent(clientX: number, clientY: number, button = 0): React.PointerEvent {
  return { button, clientX, clientY } as unknown as React.PointerEvent
}

function firePointer(type: string, clientX: number, clientY: number): void {
  act(() => {
    window.dispatchEvent(new PointerEvent(type, { clientX, clientY, bubbles: true }))
  })
}

afterEach(() => {
  clearAgentInputFocusGuards()
  if (vi.isFakeTimers()) {
    vi.runAllTimers()
  }
  vi.useRealTimers()
  webviewRegistry.clear()
  document.body.replaceChildren()
  vi.clearAllMocks()
})

describe('useTabStripPointerActivation', () => {
  it('activates a click that lands after a prior drag gesture (regression #6395)', () => {
    const onActivate = vi.fn()
    const { result } = renderHook(() => useTabStripPointerActivation({ onActivate }))

    act(() => result.current.onPointerDown(pointerDownEvent(10, 10)))
    firePointer('pointermove', 300, 10)
    firePointer('pointerup', 300, 10)
    expect(onActivate).not.toHaveBeenCalled()

    act(() => result.current.onPointerDown(pointerDownEvent(400, 10)))
    firePointer('pointerup', 400, 10)
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  // A press leaving an in-page guest restores embedder focus itself; do not mistake that handoff for an app switch.
  it('still activates when the press is what pulled focus back from a guest', () => {
    const onActivate = vi.fn()
    const guest = document.createElement('webview')
    document.body.append(guest)
    guest.tabIndex = -1
    guest.focus()
    const { result } = renderHook(() => useTabStripPointerActivation({ onActivate }))

    act(() => result.current.onPointerDown(pointerDownEvent(10, 10)))
    act(() => window.dispatchEvent(new Event('focus')))
    firePointer('pointerup', 11, 11)

    expect(onActivate).toHaveBeenCalledTimes(1)
    guest.remove()
  })

  // Forgive only the initial guest handoff; a later real app switch must cancel the press.
  it('flushes a press that outlives the guest handoff it started with', () => {
    const onActivate = vi.fn()
    const guest = document.createElement('webview')
    document.body.append(guest)
    guest.tabIndex = -1
    guest.focus()
    const { result } = renderHook(() => useTabStripPointerActivation({ onActivate }))

    act(() => result.current.onPointerDown(pointerDownEvent(10, 10)))
    act(() => window.dispatchEvent(new Event('focus')))
    act(() => window.dispatchEvent(new Event('focus')))
    firePointer('pointerup', 11, 11)

    expect(onActivate).not.toHaveBeenCalled()
    guest.remove()
  })

  // An agent's click in another page moves window focus into its guest and back; the user never left (#42119).
  it('keeps a press across the window focus bounce of agent input', () => {
    vi.useFakeTimers()
    const onActivate = vi.fn()
    const agentPage = document.createElement('webview')
    document.body.append(agentPage)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard only reads focus state from the element.
    webviewRegistry.set('agent-page', agentPage as unknown as Electron.WebviewTag)
    const { result } = renderHook(() => useTabStripPointerActivation({ onActivate }))

    act(() => result.current.onPointerDown(pointerDownEvent(10, 10)))
    expect(beginAgentInputFocusGuard('agent-page', 'agent-click')).toBe('ready')
    act(() => window.dispatchEvent(new Event('blur')))
    endAgentInputFocusGuard('agent-click')
    vi.runAllTimers()
    // The restored focus can reach the window after the guard has settled.
    act(() => window.dispatchEvent(new Event('focus')))
    firePointer('pointerup', 11, 11)

    expect(onActivate).toHaveBeenCalledTimes(1)
  })
})
