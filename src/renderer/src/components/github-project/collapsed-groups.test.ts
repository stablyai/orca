import { beforeEach, describe, expect, it } from 'vitest'
import {
  STORAGE_KEY,
  loadCollapsedGroups,
  saveCollapsedGroups
} from './collapsed-groups'

describe('collapsed-groups', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('returns an empty set when nothing is stored', () => {
    expect(loadCollapsedGroups('proj_1:view_1')).toEqual(new Set())
  })

  it('persists and retrieves collapsed groups for a scopeKey', () => {
    saveCollapsedGroups('proj_1:view_1', new Set(['opt_todo', 'opt_done']))
    expect(loadCollapsedGroups('proj_1:view_1')).toEqual(new Set(['opt_todo', 'opt_done']))
  })

  it('isolates collapsed groups across different project views', () => {
    saveCollapsedGroups('proj_1:view_1', new Set(['group_a']))
    saveCollapsedGroups('proj_1:view_2', new Set(['group_b']))
    saveCollapsedGroups('proj_2:view_1', new Set(['group_c']))

    expect(loadCollapsedGroups('proj_1:view_1')).toEqual(new Set(['group_a']))
    expect(loadCollapsedGroups('proj_1:view_2')).toEqual(new Set(['group_b']))
    expect(loadCollapsedGroups('proj_2:view_1')).toEqual(new Set(['group_c']))
  })

  it('deletes the scope entry when saving an empty set', () => {
    saveCollapsedGroups('proj_1:view_1', new Set(['opt_todo']))
    expect(loadCollapsedGroups('proj_1:view_1')).toEqual(new Set(['opt_todo']))

    saveCollapsedGroups('proj_1:view_1', new Set())
    expect(loadCollapsedGroups('proj_1:view_1')).toEqual(new Set())

    const raw = window.localStorage.getItem(STORAGE_KEY)
    expect(raw).toBe('{}')
  })

  it('handles invalid JSON gracefully', () => {
    window.localStorage.setItem(STORAGE_KEY, '{bad-json}')
    expect(loadCollapsedGroups('proj_1:view_1')).toEqual(new Set())
  })
})
