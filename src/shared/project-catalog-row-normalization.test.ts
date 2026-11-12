import { describe, expect, it } from 'vitest'
import type { Project, ProjectHostSetup } from './project-types'
import {
  normalizeProjectHostSetupRow,
  normalizeProjectHostSetupRows,
  normalizeProjectRow,
  normalizeProjectRows
} from './project-catalog-row-normalization'

// Reflect.set openly corrupts typed fixtures to model untrusted persistence/wire data without casting.
function corrupt<T extends object>(row: T, overrides: Record<string, unknown>): T {
  for (const [key, value] of Object.entries(overrides)) {
    Reflect.set(row, key, value)
  }
  return row
}

function makeSetup(overrides: Record<string, unknown> = {}): ProjectHostSetup {
  const setup: ProjectHostSetup = {
    id: 'setup-1',
    projectId: 'project-1',
    hostId: 'local',
    repoId: 'repo-1',
    path: '/Users/alice/orca',
    displayName: 'orca',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 2
  }
  return corrupt(setup, overrides)
}

function makeProject(overrides: Record<string, unknown> = {}): Project {
  const project: Project = {
    id: 'project-1',
    displayName: 'Project',
    badgeColor: '#737373',
    sourceRepoIds: ['repo-1'],
    createdAt: 1,
    updatedAt: 2
  }
  return corrupt(project, overrides)
}

describe('normalizeProjectHostSetupRow', () => {
  // Sidebar grouping trims/parses path during render, so corrupt rows crash the main window.
  it.each([
    ['null', null],
    ['a number', 7]
  ])('coerces a %s path to an empty string', (_label, path) => {
    expect(normalizeProjectHostSetupRow(makeSetup({ path })).path).toBe('')
  })

  it('falls back to the local host id for a non-string hostId', () => {
    expect(normalizeProjectHostSetupRow(makeSetup({ hostId: null })).hostId).toBe('local')
  })

  // Zero already means unknown to catalog merges; synthetic timestamps could beat real min/max evidence.
  it.each([
    ['null', null],
    ['NaN', Number.NaN],
    ['a string', '5']
  ])('coerces a %s timestamp to 0', (_label, value) => {
    const normalized = normalizeProjectHostSetupRow(
      makeSetup({ createdAt: value, updatedAt: value })
    )
    expect(normalized.createdAt).toBe(0)
    expect(normalized.updatedAt).toBe(0)
  })

  // Compared-only unions degrade safely; invented fallbacks would change the row’s claim.
  it('leaves the setupState and setupMethod unions untouched', () => {
    const normalized = normalizeProjectHostSetupRow(
      makeSetup({ repoId: null, setupState: 'bogus', setupMethod: null })
    )
    expect(normalized.setupState).toBe('bogus')
    expect(normalized.setupMethod).toBeNull()
  })

  // Merge checks in/undefined, so adding absent optional keys changes semantics.
  it('never adds or removes an optional key', () => {
    const withoutOptionals = normalizeProjectHostSetupRow(makeSetup({ repoId: null }))
    expect('connectionId' in withoutOptionals).toBe(false)
    expect('worktreeBasePath' in withoutOptionals).toBe(false)
    const withOptionals = normalizeProjectHostSetupRow(
      makeSetup({ repoId: null, connectionId: null, worktreeBasePath: '/base' })
    )
    expect('connectionId' in withOptionals).toBe(true)
    expect(withOptionals.worktreeBasePath).toBe('/base')
  })
})

describe('normalizeProjectRow', () => {
  // Why: the compatibility merge spreads `sourceRepoIds`, which throws on a non-array.
  it.each([
    ['null', null, []],
    ['a string', 'repo-1', []],
    ['an array with holes', ['repo-1', null, 3], ['repo-1']]
  ])('repairs a %s sourceRepoIds', (_label, sourceRepoIds, expected) => {
    expect(normalizeProjectRow(makeProject({ sourceRepoIds })).sourceRepoIds).toEqual(expected)
  })

  // Why: `'localWindowsRuntimePreference' in overlay` decides whether a preference clear wins.
  it('never materialises an absent localWindowsRuntimePreference', () => {
    const normalized = normalizeProjectRow(makeProject({ id: null }))
    expect('localWindowsRuntimePreference' in normalized).toBe(false)
  })
})

describe('row array normalization', () => {
  it('repairs null rows without throwing', () => {
    const setups = [null] as unknown as ProjectHostSetup[]
    const projects = [null] as unknown as Project[]
    expect(normalizeProjectHostSetupRows(setups)[0]).toMatchObject({
      id: '',
      repoId: '',
      path: ''
    })
    expect(normalizeProjectRows(projects)[0]).toMatchObject({
      id: '',
      sourceRepoIds: []
    })
  })

  // Coercion must not change row membership; the old selector invented repo-derived rows when fields changed.
  it('preserves row count and order', () => {
    const setups = [makeSetup({ repoId: null }), makeSetup({ id: 'setup-2' })]
    expect(normalizeProjectHostSetupRows(setups).map((setup) => setup.id)).toEqual([
      'setup-1',
      'setup-2'
    ])
  })
})
