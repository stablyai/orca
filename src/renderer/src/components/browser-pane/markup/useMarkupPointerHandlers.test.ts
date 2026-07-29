// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMarkupPointerHandlers, type MarkupPointerParams } from './useMarkupPointerHandlers'
import type { MarkupShape } from './markup-drawing-model'

const realCrypto = globalThis.crypto

function pointerDownEvent(clientX: number, clientY: number): React.PointerEvent<HTMLCanvasElement> {
  return {
    button: 0,
    clientX,
    clientY,
    currentTarget: { setPointerCapture: vi.fn() },
    pointerId: 1
  } as unknown as React.PointerEvent<HTMLCanvasElement>
}

function baseParams(overrides: Partial<MarkupPointerParams> = {}): MarkupPointerParams {
  return {
    busy: false,
    tool: 'pen',
    color: '#ef4444',
    width: 4,
    pendingText: null,
    canvasRef: {
      current: {
        getBoundingClientRect: () => ({ left: 0, top: 0 })
      } as unknown as HTMLCanvasElement
    },
    setInProgress: vi.fn(),
    setPendingText: vi.fn(),
    setDoc: vi.fn(),
    ...overrides
  }
}

describe('useMarkupPointerHandlers in a non-secure browser context', () => {
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

  it('starts a pen stroke with a valid id instead of throwing', () => {
    const setInProgress = vi.fn()
    const { result } = renderHook(() => useMarkupPointerHandlers(baseParams({ setInProgress })))

    expect(() => act(() => result.current.onPointerDown(pointerDownEvent(10, 10)))).not.toThrow()

    expect(setInProgress).toHaveBeenCalledTimes(1)
    const shape = setInProgress.mock.calls[0][0] as MarkupShape
    expect(shape.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})
