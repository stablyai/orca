// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMarkupPointerHandlers, type MarkupPointerParams } from './useMarkupPointerHandlers'
import { createMarkupDocument } from './markup-drawing-model'
import type { MarkupEditorState } from './markup-gesture'

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
    measureTextInkBox: () => null,
    setPendingText: vi.fn(),
    setState: vi.fn(),
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
    let state: MarkupEditorState = { doc: createMarkupDocument(), gesture: null }
    const setState: MarkupPointerParams['setState'] = (update) => {
      state = typeof update === 'function' ? update(state) : update
    }
    const { result } = renderHook(() => useMarkupPointerHandlers(baseParams({ setState })))

    expect(() => act(() => result.current.onPointerDown(pointerDownEvent(10, 10)))).not.toThrow()

    expect(state.gesture).toMatchObject({
      kind: 'draw',
      shape: {
        id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      }
    })
  })
})
