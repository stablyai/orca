import { describe, expect, it, vi } from 'vitest'
import type { WorktreeVisibilityDefaults } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    values
      ? fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values[name] ?? ''))
      : fallback
}))

const {
  getWorktreeVisibilityOverrideNotice,
  getWorktreeVisibilitySourceNote,
  getWorktreeVisibilitySourceProvenance,
  listInheritedWorktreeVisibilitySources
} = await import('./worktree-visibility-source-provenance')

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'orca',
    badgeColor: '#000000',
    addedAt: 0,
    externalWorktreeVisibility: undefined,
    ...overrides
  }
}

const shownClaude: WorktreeVisibilityDefaults = {
  external: 'hide',
  sourcePreferences: { builtIn: { claude: 'show' } }
}

const NO_REPO_SOURCES: ReadonlySet<string> = new Set()

function provenanceFor(target: Repo, defaults: WorktreeVisibilityDefaults) {
  return getWorktreeVisibilitySourceProvenance(
    target,
    { kind: 'built-in', id: 'claude' },
    defaults,
    NO_REPO_SOURCES
  )
}

describe('listInheritedWorktreeVisibilitySources', () => {
  it('reports what each inheritable source is set to globally', () => {
    expect(listInheritedWorktreeVisibilitySources(repo(), shownClaude)).toEqual([
      { source: { kind: 'built-in', id: 'claude' }, globalVisibility: 'show' },
      { source: { kind: 'built-in', id: 'gsd' }, globalVisibility: 'hide' },
      { source: { kind: 'other' }, globalVisibility: 'hide' }
    ])
  })

  it('keeps a source the project has overridden, since global is what it overrode', () => {
    const overridden = listInheritedWorktreeVisibilitySources(
      repo({ worktreeVisibilitySourcePreferences: { builtIn: { claude: 'hide' } } }),
      shownClaude
    )
    expect(overridden[0]).toEqual({
      source: { kind: 'built-in', id: 'claude' },
      globalVisibility: 'show'
    })
  })

  it('lists a global custom source but not one the project added itself', () => {
    const listed = listInheritedWorktreeVisibilitySources(
      repo({ customWorktreeVisibilitySources: [{ id: 'local', rootPath: '/srv/local' }] }),
      {
        external: 'hide',
        customSources: [{ id: 'team', rootPath: '/srv/team' }],
        sourcePreferences: { custom: { team: 'show' } }
      }
    )
    expect(listed.map(({ source }) => source)).toContainEqual({
      kind: 'custom',
      source: { id: 'team', rootPath: '/srv/team' }
    })
    expect(
      listed.some(({ source }) => source.kind === 'custom' && source.source.id === 'local')
    ).toBe(false)
  })
})

describe('getWorktreeVisibilityOverrideNotice', () => {
  it('names the global value a project override is ignoring', () => {
    const provenance = provenanceFor(
      repo({ worktreeVisibilitySourcePreferences: { builtIn: { claude: 'hide' } } }),
      shownClaude
    )
    expect(getWorktreeVisibilityOverrideNotice(provenance, 'hide')).toBe(
      'Overriding global setting: Show'
    )
  })

  it('stays quiet for an override that agrees with global settings', () => {
    // Why: a legacy repo materializes an override on every source, most of which change nothing.
    const provenance = provenanceFor(repo({ agentWorktreeVisibility: 'show' }), shownClaude)
    expect(provenance?.kind).toBe('project-override')
    expect(getWorktreeVisibilityOverrideNotice(provenance, 'show')).toBeNull()
  })

  it('stays quiet for a source that is still following global settings', () => {
    expect(
      getWorktreeVisibilityOverrideNotice(provenanceFor(repo(), shownClaude), 'show')
    ).toBeNull()
  })

  it('stays quiet outside a project scope', () => {
    expect(getWorktreeVisibilityOverrideNotice(null, 'show')).toBeNull()
  })
})

describe('getWorktreeVisibilitySourceNote', () => {
  it('marks a source the project added itself', () => {
    const provenance = getWorktreeVisibilitySourceProvenance(
      repo({ customWorktreeVisibilitySources: [{ id: 'local', rootPath: '/srv/local' }] }),
      { kind: 'custom', source: { id: 'local', rootPath: '/srv/local' } },
      { external: 'hide' },
      new Set(['local'])
    )
    expect(getWorktreeVisibilitySourceNote(provenance)).toBe('Added in this project only.')
  })

  it('says nothing for an inherited source', () => {
    expect(getWorktreeVisibilitySourceNote(provenanceFor(repo(), shownClaude))).toBeNull()
  })
})
