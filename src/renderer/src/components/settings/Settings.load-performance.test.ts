import { describe, expect, it } from 'vitest'
import { deriveNeededSectionIds } from './settings-load-performance'

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

  it('keeps search mounting scoped to the active section', () => {
    const needed = deriveNeededSectionIds({
      navSectionIds: ['general', 'agents', 'appearance', 'terminal', 'stats', 'repo-a'],
      mountedSectionIds: new Set(['general']),
      activeSectionId: 'general',
      pendingSectionId: null,
      query: 'stats',
      visibleSectionIds: new Set(['stats'])
    })

    expect(needed.has('stats')).toBe(false)
    expect(needed.has('general')).toBe(false)
  })

  it('mounts the active matched section during search', () => {
    const needed = deriveNeededSectionIds({
      navSectionIds: ['general', 'agents', 'appearance', 'terminal', 'stats', 'repo-a'],
      mountedSectionIds: new Set(['general']),
      activeSectionId: 'stats',
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
})
