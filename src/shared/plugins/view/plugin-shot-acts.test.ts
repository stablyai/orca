import { describe, expect, it } from 'vitest'
import { parsePluginShotActs, PLUGIN_SHOT_MAX_ACTS } from './plugin-shot-acts'

describe('parsePluginShotActs', () => {
  it('takes the four verbs, and one act without a list', () => {
    const json = JSON.stringify([
      { press: { text: 'Add' } },
      { type: { label: 'New task' }, text: 'Ship', submit: true },
      { select: { label: 'View' }, value: 'done' },
      { toggle: { testId: 'hide-done' } }
    ])
    expect(parsePluginShotActs(json)).toMatchObject({ ok: true, acts: { length: 4 } })
    expect(parsePluginShotActs('{"press":{"role":"button"}}')).toEqual({
      ok: true,
      acts: [{ press: { role: 'button' } }]
    })
  })

  it("takes the kit's Slider, Table and Tree verbs with their arguments", () => {
    const table = { type: 'Table' }
    const tree = { label: 'Folders' }
    const json = JSON.stringify([
      { slide: { label: 'Volume' }, value: 7 },
      { sort: table, column: 'name' },
      { selectRows: table, keys: ['a', 'b'] },
      { activateRow: table, key: 'a' },
      { loadMore: table },
      { expand: tree, key: 'src' },
      { collapse: tree, key: 'src' },
      { selectItem: tree, key: 'src/main.ts' },
      { activateItem: tree, key: 'src/main.ts' }
    ])
    expect(parsePluginShotActs(json)).toMatchObject({ ok: true, acts: { length: 9 } })
    expect(parsePluginShotActs('{"slide":{"label":"Volume"},"value":"7"}')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^action 1 \(slide\) \(value\): /)
    })
    expect(parsePluginShotActs('{"expand":{"label":"Folders"}}')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^action 1 \(expand\) \(key\): /)
    })
  })

  it('names the act and field that is wrong', () => {
    expect(parsePluginShotActs('[{"press":{"text":"A"}},{"click":{}}]')).toEqual({
      ok: false,
      error:
        'action 2: expected an object with one of press, type, select, toggle, slide, sort, selectRows, activateRow, loadMore, expand, collapse, selectItem, activateItem'
    })
    expect(parsePluginShotActs('[{"type":{"label":"Name"}}]')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^action 1 \(type\) \(text\): /)
    })
    expect(parsePluginShotActs('[{"press":{}}]')).toMatchObject({
      ok: false,
      error: expect.stringContaining('at least one of type, role, text, label or testId')
    })
    expect(parsePluginShotActs('[{"press":{"text":"A","nth":2}}]')).toMatchObject({ ok: false })
  })

  it('refuses non-JSON, an empty list and more than the cap', () => {
    expect(parsePluginShotActs('[press]')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^not JSON/)
    })
    expect(parsePluginShotActs('[]')).toMatchObject({ ok: false })
    const many = Array.from({ length: PLUGIN_SHOT_MAX_ACTS + 1 }, () => ({ press: { text: 'A' } }))
    expect(parsePluginShotActs(JSON.stringify(many))).toEqual({
      ok: false,
      error: `at most ${PLUGIN_SHOT_MAX_ACTS} actions`
    })
  })
})
