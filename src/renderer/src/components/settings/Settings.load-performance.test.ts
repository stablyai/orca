import { describe, expect, it } from 'vitest'
import {
  deriveNeededRepoIds,
  deriveNeededSectionIds,
  getRuntimeTargetIdentity
} from './settings-load-performance'

describe('Settings load-performance helpers', () => {
  it('keeps only eager and active sections mounted for empty search on first paint', () => {
    const needed = deriveNeededSectionIds({
      navSectionIds: ['general', 'agents', 'appearance', 'terminal', 'stats', 'ssh', 'repo-a'],
      mountedSectionIds: new Set(['general']),
      activeSectionId: 'general',
      pendingSectionId: null,
      query: '',
      visibleSectionIds: new Set([
        'general',
        'agents',
        'appearance',
        'terminal',
        'stats',
        'ssh',
        'repo-a'
      ])
    })

    expect(Array.from(needed).sort()).toEqual(['general'])
  })

  it('adds matched sections immediately when search is non-empty', () => {
    const needed = deriveNeededSectionIds({
      navSectionIds: ['general', 'agents', 'appearance', 'terminal', 'stats', 'repo-a'],
      mountedSectionIds: new Set(['general']),
      activeSectionId: 'general',
      pendingSectionId: null,
      query: 'stats',
      visibleSectionIds: new Set(['stats'])
    })

    expect(needed.has('stats')).toBe(true)
  })

  it('keeps a pending deep-link target mounted before jump work continues', () => {
    const needed = deriveNeededSectionIds({
      navSectionIds: ['general', 'agents', 'appearance', 'terminal', 'repo-a'],
      mountedSectionIds: new Set(['general']),
      activeSectionId: 'general',
      pendingSectionId: 'repo-a',
      query: '',
      visibleSectionIds: new Set(['general', 'agents', 'appearance', 'terminal', 'repo-a'])
    })

    expect(needed.has('repo-a')).toBe(true)
  })

  it('scopes repo hook checks to needed repo sections only', () => {
    const neededRepoIds = deriveNeededRepoIds(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      new Set(['general', 'repo-b'])
    )

    expect(neededRepoIds).toEqual(['b'])
  })

  it('normalizes runtime target identity for cache invalidation keys', () => {
    expect(getRuntimeTargetIdentity({ activeRuntimeEnvironmentId: null })).toBe('local')
    expect(getRuntimeTargetIdentity({ activeRuntimeEnvironmentId: '  env-1  ' })).toBe('env-1')
  })
})
