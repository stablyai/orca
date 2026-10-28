// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  loadLastMultiRepoSet,
  recordSingleProjectCreate,
  saveLastMultiRepoSet
} from './multi-repo-last-set-storage'

beforeEach(() => {
  localStorage.clear()
})

describe('last multi-repo set storage', () => {
  it('round-trips a set and removes it on null', () => {
    saveLastMultiRepoSet({ projectIds: ['a', 'b'], singleCreatesSince: 0 })
    expect(loadLastMultiRepoSet()).toEqual({ projectIds: ['a', 'b'], singleCreatesSince: 0 })
    saveLastMultiRepoSet(null)
    expect(loadLastMultiRepoSet()).toBeNull()
  })

  it('ignores corrupt or malformed values', () => {
    localStorage.setItem('orca.new-workspace.last-multi-repo-set.v1', '{not json')
    expect(loadLastMultiRepoSet()).toBeNull()
    localStorage.setItem(
      'orca.new-workspace.last-multi-repo-set.v1',
      JSON.stringify({ projectIds: [1], singleCreatesSince: 0 })
    )
    expect(loadLastMultiRepoSet()).toBeNull()
  })

  it('clears the memory after two single-project creates', () => {
    saveLastMultiRepoSet({ projectIds: ['a', 'b'], singleCreatesSince: 0 })
    recordSingleProjectCreate('a')
    expect(loadLastMultiRepoSet()?.singleCreatesSince).toBe(1)
    recordSingleProjectCreate('a')
    expect(loadLastMultiRepoSet()).toBeNull()
  })
})
