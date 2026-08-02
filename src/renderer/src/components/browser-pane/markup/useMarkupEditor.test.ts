// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMarkupEditor } from './useMarkupEditor'

const realCrypto = globalThis.crypto

function pointerDownEvent(clientX: number, clientY: number): React.PointerEvent<HTMLCanvasElement> {
  return {
    button: 0,
    clientX,
    clientY,
    currentTarget: { setPointerCapture: vi.fn() },
    pointerId: 1,
    preventDefault: vi.fn()
  } as unknown as React.PointerEvent<HTMLCanvasElement>
}

describe('useMarkupEditor.commitPendingText in a non-secure browser context', () => {
  beforeEach(() => {
    // Match a non-secure browser context (LAN web client over plain HTTP):
    // getRandomValues stays, randomUUID is undefined.
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) }
    })
  })

  afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: realCrypto })
  })

  it('commits a text shape with a valid id instead of throwing', () => {
    const { result } = renderHook(() => useMarkupEditor(false, vi.fn()))

    act(() => result.current.setTool('text'))
    act(() => result.current.onPointerDown(pointerDownEvent(5, 5)))
    expect(result.current.pendingText).not.toBeNull()

    expect(() => act(() => result.current.commitPendingText('hello'))).not.toThrow()

    const shape = result.current.shapes.at(-1)
    expect(shape?.kind).toBe('text')
    expect(shape?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})
