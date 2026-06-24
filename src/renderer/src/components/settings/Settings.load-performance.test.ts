import { describe, expect, it } from 'vitest'
import {
  deriveNeededRepoIds,
  deriveNeededSectionIds,
  getRuntimeTargetIdentity
} from './settings-load-performance'
import { getRepoSettingsSectionId } from '@/lib/repo-settings-section-id'

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

  it('scopes repo hook checks to needed repo sections only', () => {
    const targetRepo = { id: 'b' }
    const neededRepoIds = deriveNeededRepoIds(
      [{ id: 'a' }, targetRepo, { id: 'c' }],
      new Set(['general', getRepoSettingsSectionId(targetRepo)])
    )

    expect(neededRepoIds).toEqual(['b'])
  })

  it('distinguishes same-id repo sections by host', () => {
    const localRepo = { id: 'same-repo' }
    const remoteRepo = { id: 'same-repo', connectionId: 'gpu-vm' }

    expect(
      deriveNeededRepoIds([localRepo, remoteRepo], new Set([getRepoSettingsSectionId(remoteRepo)]))
    ).toEqual(['same-repo'])
    expect(getRepoSettingsSectionId(localRepo)).not.toBe(getRepoSettingsSectionId(remoteRepo))
  })

  it('normalizes runtime target identity for cache invalidation keys', () => {
    expect(getRuntimeTargetIdentity({ activeRuntimeEnvironmentId: null })).toBe('local')
    expect(getRuntimeTargetIdentity({ activeRuntimeEnvironmentId: '  env-1  ' })).toBe('env-1')
  })
})
