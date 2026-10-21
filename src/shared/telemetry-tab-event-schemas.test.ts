import { describe, expect, it } from 'vitest'
import { eventSchemas } from './telemetry-events'

const valid = {
  direction: 'left',
  tab_type: 'terminal',
  surface: 'workspace',
  eligible_tab_count: 2
}

describe('tabs_directional_close_requested schema', () => {
  it('accepts requests, including empty selections', () => {
    for (const direction of ['left', 'right']) {
      for (const surface of ['workspace', 'floating']) {
        for (const eligible_tab_count of [0, 2]) {
          const props = { ...valid, direction, surface, eligible_tab_count }
          expect(eventSchemas.tabs_directional_close_requested.parse(props)).toEqual(props)
        }
      }
    }
  })

  it.each([
    { direction: 'others' },
    { tab_type: 'private title' },
    { surface: 'unknown' },
    { eligible_tab_count: -1 },
    { eligible_tab_count: 1.5 },
    { eligible_tab_count: '2' },
    { sample_rate: 1 },
    { tab_id: '/private/file.ts' },
    { title: 'private title' },
    { worktree_id: 'private workspace' }
  ])('rejects invalid values and private fields: %j', (extra) => {
    expect(
      eventSchemas.tabs_directional_close_requested.safeParse({ ...valid, ...extra }).success
    ).toBe(false)
  })
})
