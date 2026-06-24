import { describe, expect, it } from 'vitest'
import { getDragPointer } from './tab-drag-pointer'

describe('getDragPointer', () => {
  it('uses the activator client coordinates plus drag delta', () => {
    expect(
      getDragPointer({
        activatorEvent: { clientX: 100, clientY: 40 },
        delta: { x: 250, y: 10 },
        active: { rect: { current: { initial: null, translated: null } } }
      } as unknown as Parameters<typeof getDragPointer>[0])
    ).toEqual({ x: 350, y: 50 })
  })
})
