import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { getProjectGroupingIndexFromState } from './project-host-setup-selector'

type CollectionCounters = {
  map: number
  flatMap: number
  iterator: number
  length: number
}

function countCollectionReads<T>(items: readonly T[]): {
  value: readonly T[]
  counters: CollectionCounters
} {
  const target = [...items]
  const counters: CollectionCounters = { map: 0, flatMap: 0, iterator: 0, length: 0 }
  const value = new Proxy(target, {
    get(array, property) {
      if (property === 'map' || property === 'flatMap') {
        counters[property] += 1
        return array[property].bind(array)
      }
      if (property === Symbol.iterator) {
        counters.iterator += 1
        return array[Symbol.iterator].bind(array)
      }
      if (property === 'length') {
        counters.length += 1
      }
      // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy get trap default forward.
      return Reflect.get(array, property)
    }
  })
  return { value, counters }
}

function makeRepo(id: string): Repo {
  return {
    id,
    path: `/repo/${id}`,
    displayName: id,
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git'
  }
}

describe('project host setup selector', () => {
  it.each([100, 1000])(
    'does no catalog traversal on unrelated notifications with %i registrations',
    (count) => {
      const repos = countCollectionReads(
        Array.from({ length: count }, (_, i) => makeRepo(`repo-${i}`))
      )
      const state = {
        repos: repos.value,
        settings: {
          projectGroupingMode: 'repository' as const,
          projectGroupingOverrides: { 'repo:repo-0': 'repository' as const }
        }
      }
      const index = getProjectGroupingIndexFromState(state)
      expect(index.groups).toHaveLength(count)
      Object.assign(repos.counters, { map: 0, flatMap: 0, iterator: 0, length: 0 })
      for (let i = 0; i < count; i++) {
        expect(
          getProjectGroupingIndexFromState({
            ...state,
            settings: {
              ...state.settings,
              projectGroupingOverrides: { ...state.settings.projectGroupingOverrides }
            }
          })
        ).toBe(index)
      }
      expect(repos.counters).toEqual({ map: 0, flatMap: 0, iterator: 0, length: 0 })
      expect(
        getProjectGroupingIndexFromState({
          ...state,
          settings: {
            ...state.settings,
            projectGroupingOverrides: { 'repo:repo-0': 'folder' }
          }
        })
      ).not.toBe(index)
      expect(
        getProjectGroupingIndexFromState({ ...state, settings: { projectGroupingMode: 'folder' } })
      ).not.toBe(index)
    }
  )
})
