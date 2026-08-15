import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../repo-types'
import {
  buildDefaultWorktreeSourcePreferenceUpdate,
  buildWorktreeSourcePreferenceUpdate
} from './visibility-source-preferences'
import {
  createWorktreeVisibilitySourceMatcher,
  effectiveBuiltInWorktreeSourceVisibility,
  effectiveCustomWorktreeSourceVisibility,
  normalizeCustomWorktreeVisibilitySources,
  normalizeWorktreeVisibilitySourcePreferences,
  resolveCustomWorktreeVisibilitySources
} from './visibility-sources'

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'repo',
    addedAt: 1,
    ...overrides,
    badgeColor: overrides.badgeColor ?? '#fff'
  }
}

describe('worktree visibility sources', () => {
  it('classifies each built-in independently across linked checkouts', () => {
    const classify = createWorktreeVisibilitySourceMatcher(['/repo', '/worktrees/feature'])
    expect(classify('/repo/.claude/worktrees/review')).toEqual({
      kind: 'built-in',
      id: 'claude'
    })
    expect(classify('/worktrees/feature/.gsd-workspaces/phase-1')).toEqual({
      kind: 'built-in',
      id: 'gsd'
    })
    expect(classify('/other/.claude/worktrees/review')).toBeNull()
  })

  it('matches custom descendants with Windows and WSL comparison semantics', () => {
    const windows = createWorktreeVisibilitySourceMatcher(
      [],
      [{ id: 'team', rootPath: 'C:\\Users\\Dev\\Team' }]
    )
    expect(windows('c:\\users\\dev\\team\\feature')).toEqual({
      kind: 'custom',
      id: 'team'
    })

    const wsl = createWorktreeVisibilitySourceMatcher(
      [],
      [{ id: 'linux', rootPath: '//wsl$/Ubuntu/home/dev/team' }]
    )
    expect(wsl('//wsl.localhost/Ubuntu/home/dev/team/feature')).toEqual({
      kind: 'custom',
      id: 'linux'
    })
    expect(wsl('//wsl.localhost/Ubuntu/home/Dev/team/feature')).toBeNull()
  })

  it('gives built-ins precedence over overlapping custom roots', () => {
    const classify = createWorktreeVisibilitySourceMatcher(
      ['/repo'],
      [{ id: 'overlap', rootPath: '/repo/.claude/worktrees' }]
    )
    expect(classify('/repo/.claude/worktrees/review')).toEqual({
      kind: 'built-in',
      id: 'claude'
    })
  })

  it('normalizes each candidate once regardless of checkout count', () => {
    const classify = createWorktreeVisibilitySourceMatcher(
      Array.from({ length: 200 }, (_, index) => `/repo/worktree-${index}`),
      Array.from({ length: 32 }, (_, index) => ({
        id: `custom-${index}`,
        rootPath: `/custom/${index}`
      }))
    )
    const normalize = vi.spyOn(String.prototype, 'normalize')

    classify('/unmatched/worktree')

    expect(normalize).toHaveBeenCalledTimes(1)
    normalize.mockRestore()
  })

  it('migrates the optional legacy agent policy lazily for both built-ins', () => {
    const legacy = repo({ agentWorktreeVisibility: 'show' })
    expect(effectiveBuiltInWorktreeSourceVisibility(legacy, 'claude')).toBe('show')
    expect(effectiveBuiltInWorktreeSourceVisibility(legacy, 'gsd')).toBe('show')
    expect(
      buildWorktreeSourcePreferenceUpdate(legacy, { kind: 'built-in', id: 'claude' }, 'hide')
    ).toEqual({ builtIn: { claude: 'hide', gsd: 'show' } })
  })

  it('inherits global built-in and custom visibility without stamping sibling defaults', () => {
    const defaults = {
      external: 'hide' as const,
      customSources: [{ id: 'team', rootPath: '/srv/team' }],
      sourcePreferences: {
        builtIn: { claude: 'show' as const, gsd: 'show' as const },
        custom: { team: 'show' as const }
      }
    }
    const inherited = repo()

    expect(effectiveBuiltInWorktreeSourceVisibility(inherited, 'gsd', defaults)).toBe('show')
    expect(effectiveCustomWorktreeSourceVisibility(inherited, 'team', defaults)).toBe('show')
    expect(
      buildWorktreeSourcePreferenceUpdate(inherited, { kind: 'built-in', id: 'claude' }, 'hide')
    ).toEqual({ builtIn: { claude: 'hide' } })
    expect(
      buildWorktreeSourcePreferenceUpdate(inherited, { kind: 'custom', id: 'team' }, 'hide')
    ).toEqual({ custom: { team: 'hide' } })
    expect(inherited.worktreeVisibilitySourcePreferences).toBeUndefined()
  })

  it('resolves global custom roots for every repo and keeps new global defaults isolated', () => {
    const defaults = {
      external: 'hide' as const,
      customSources: [{ id: 'global', rootPath: '/srv/global-worktrees' }]
    }
    for (const checkout of ['/repos/alpha', '/repos/beta']) {
      const current = repo({ path: checkout })
      const classify = createWorktreeVisibilitySourceMatcher(
        [checkout],
        resolveCustomWorktreeVisibilitySources(current, defaults)
      )
      expect(classify('/srv/global-worktrees/feature')).toEqual({
        kind: 'custom',
        id: 'global'
      })
    }
    expect(
      buildDefaultWorktreeSourcePreferenceUpdate(defaults, { kind: 'custom', id: 'global' }, 'hide')
    ).toEqual({ custom: { global: 'hide' } })
  })

  it('bounds and sanitizes persisted source definitions and preferences', () => {
    expect(
      normalizeCustomWorktreeVisibilitySources([
        { id: 'team', rootPath: ' /srv/team/ ' },
        { id: 'duplicate-root', rootPath: '/srv/team' },
        { id: 'relative', rootPath: '../team' },
        { id: 'bad id', rootPath: '/srv/other' }
      ])
    ).toEqual([{ id: 'team', rootPath: '/srv/team/' }])
    expect(
      normalizeWorktreeVisibilitySourcePreferences({
        builtIn: { claude: 'show', gsd: 'invalid', unknown: 'show' },
        custom: { team: 'hide', nope: 'invalid' }
      })
    ).toEqual({ builtIn: { claude: 'show' }, custom: { team: 'hide' } })
  })

  it('rejects drive-relative Windows roots and caps after validation', () => {
    const invalid = Array.from({ length: 32 }, (_, index) => ({
      id: `bad-${index}`,
      rootPath: 'relative'
    }))
    expect(
      normalizeCustomWorktreeVisibilitySources([...invalid, { id: 'team', rootPath: '/srv/team' }])
    ).toEqual([{ id: 'team', rootPath: '/srv/team' }])
    expect(
      normalizeCustomWorktreeVisibilitySources([
        { id: 'drive-relative', rootPath: 'C:Users\\dev\\team' },
        { id: 'root-relative', rootPath: '\\Users\\dev\\team' },
        { id: 'drive', rootPath: 'C:\\Users\\dev\\team' },
        { id: 'unc', rootPath: '\\\\server\\share\\team' }
      ])
    ).toEqual([
      { id: 'drive', rootPath: 'C:\\Users\\dev\\team' },
      { id: 'unc', rootPath: '\\\\server\\share\\team' }
    ])
  })
})
