import { describe, expect, it } from 'vitest'
import { parsePluginShotActs, PLUGIN_SHOT_MAX_ACTS } from './plugin-shot-acts'

describe('parsePluginShotActs', () => {
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
