import { describe, expect, it } from 'vitest'
import { pluginEditorActInputEvents } from './plugin-editor-shot-acts'

describe('editor shot --act', () => {
  it('turns a click into a press and release at the point, offset into the target', () => {
    expect(pluginEditorActInputEvents({ click: [10, 20] }, { x: 100, y: 40 }, 2)).toEqual([
      { type: 'mouseMove', x: 220, y: 120 },
      { type: 'mouseDown', x: 220, y: 120, button: 'left', clickCount: 1 },
      { type: 'mouseUp', x: 220, y: 120, button: 'left', clickCount: 1 }
    ])
  })

  it('moves a drag in steps with the button held, ending at its target', () => {
    const events = pluginEditorActInputEvents({
      drag: [
        [0, 0],
        [80, 40]
      ]
    })
    expect(events[1]).toMatchObject({ type: 'mouseDown', x: 0, y: 0 })
    const moves = events.slice(2, -1)
    expect(moves.length).toBeGreaterThan(1)
    expect(moves.every((event) => event.modifiers?.includes('leftbuttondown'))).toBe(true)
    expect(moves.at(-1)).toMatchObject({ x: 80, y: 40 })
    expect(events.at(-1)).toMatchObject({ type: 'mouseUp', x: 80, y: 40 })
  })
})
