import { describe, expect, it } from 'vitest'
import { parsePluginEditorShotActs, pluginEditorActInputEvents } from './plugin-editor-shot-acts'

describe('editor shot --act', () => {
  it('reads clicks, drags and keys, and names the first bad act', () => {
    expect(
      parsePluginEditorShotActs(
        '[{"click":[200,150]},{"drag":[[200,150],[400,300]]},{"key":"r"},{"key":"z","modifiers":["meta"]}]'
      )
    ).toEqual({
      ok: true,
      acts: [
        { click: [200, 150] },
        {
          drag: [
            [200, 150],
            [400, 300]
          ]
        },
        { key: 'r' },
        { key: 'z', modifiers: ['meta'] }
      ]
    })
    expect(parsePluginEditorShotActs('{"click":[1,2]}')).toMatchObject({ ok: true })
    expect(parsePluginEditorShotActs('[{"click":[1,2]},{"click":[-1,2]}]')).toMatchObject({
      ok: false,
      error: expect.stringContaining('action 2 (click)')
    })
    expect(parsePluginEditorShotActs('[{"press":{"text":"Go"}}]')).toMatchObject({
      ok: false,
      error: 'action 1: expected an object with one of click, drag, key'
    })
    expect(parsePluginEditorShotActs('[]')).toMatchObject({ ok: false })
    expect(parsePluginEditorShotActs('not json')).toMatchObject({ ok: false })
  })

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

  it('types a character only for a printable key without a command modifier', () => {
    expect(pluginEditorActInputEvents({ key: 'r' }).map((event) => event.type)).toEqual([
      'keyDown',
      'char',
      'keyUp'
    ])
    expect(pluginEditorActInputEvents({ key: 'Enter' }).map((event) => event.type)).toEqual([
      'keyDown',
      'keyUp'
    ])
    expect(pluginEditorActInputEvents({ key: 'z', modifiers: ['meta'] })).toEqual([
      { type: 'keyDown', keyCode: 'z', modifiers: ['meta'] },
      { type: 'keyUp', keyCode: 'z', modifiers: ['meta'] }
    ])
  })
})
