import { afterEach, describe, expect, it } from 'vitest'
import { makeTabDragEvent } from './tab-drag-event-fixture'
import { getDragPointer, recordTabDragPointer } from './tab-drag-pointer'

// A drag out of a tab strip scrolled 335px: dnd-kit's delta derives x=412 for a cursor at 747.
const scrollShiftedEvent = makeTabDragEvent({
  activeData: {},
  overData: null,
  pointerDown: { x: 1275, y: 19 },
  derivedPointer: { x: 412, y: 890 }
})

afterEach(() => recordTabDragPointer(null))

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

  it('prefers the recorded cursor over a scroll-shifted delta', () => {
    recordTabDragPointer({ x: 747, y: 890 })
    expect(getDragPointer(scrollShiftedEvent)).toEqual({ x: 747, y: 890 })
  })

  it('falls back to the delta once the recorded cursor is cleared', () => {
    recordTabDragPointer({ x: 747, y: 890 })
    recordTabDragPointer(null)
    expect(getDragPointer(scrollShiftedEvent)).toEqual({ x: 412, y: 890 })
  })
})
