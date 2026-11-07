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
  it('returns the input reference when every declared type already holds', () => {
    const setup = makeSetup()
    expect(normalizeProjectHostSetupRow(setup)).toBe(setup)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object', {}]
  ])('coerces a %s repoId to an empty string', (_label, repoId) => {
    expect(normalizeProjectHostSetupRow(makeSetup({ repoId })).repoId).toBe('')
  })

  // Sidebar grouping trims/parses path during render, so corrupt rows crash the main window.
  it.each([
    ['null', null],
    ['a number', 7]
  ])('coerces a %s path to an empty string', (_label, path) => {
    expect(normalizeProjectHostSetupRow(makeSetup({ path })).path).toBe('')
  })

  it('coerces every other required string field', () => {
    const normalized = normalizeProjectHostSetupRow(
      makeSetup({ id: null, projectId: null, displayName: null })
    )
    expect(normalized.id).toBe('')
    expect(normalized.projectId).toBe('')
    expect(normalized.displayName).toBe('')
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
  it('returns the input reference when every declared type already holds', () => {
    const project = makeProject()
    expect(normalizeProjectRow(project)).toBe(project)
  })

  // Why: the compatibility merge spreads `sourceRepoIds`, which throws on a non-array.
  it.each([
    ['null', null, []],
    ['a string', 'repo-1', []],
    ['an array with holes', ['repo-1', null, 3], ['repo-1']]
  ])('repairs a %s sourceRepoIds', (_label, sourceRepoIds, expected) => {
    expect(normalizeProjectRow(makeProject({ sourceRepoIds })).sourceRepoIds).toEqual(expected)
  })

  it('coerces the required string fields', () => {
    const normalized = normalizeProjectRow(
      makeProject({ id: null, displayName: null, badgeColor: 42 })
    )
    expect(normalized.id).toBe('')
    expect(normalized.displayName).toBe('')
    expect(normalized.badgeColor).toBe('')
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

  it('returns the input array when nothing needed repair', () => {
    const setups = [makeSetup(), makeSetup({ id: 'setup-2' })]
    expect(normalizeProjectHostSetupRows(setups)).toBe(setups)
    const projects = [makeProject()]
    expect(normalizeProjectRows(projects)).toBe(projects)
  })

  // Preserve references used as TerminalPane/quick-command useMemo dependencies.
  it('reuses untouched rows and only reallocates the repaired one', () => {
    const setups = [
      makeSetup(),
      makeSetup({ id: 'setup-2', repoId: null }),
      makeSetup({ id: 's3' })
    ]
    const normalized = normalizeProjectHostSetupRows(setups)
    expect(normalized).not.toBe(setups)
    expect(normalized[0]).toBe(setups[0])
    expect(normalized[1]).not.toBe(setups[1])
    expect(normalized[2]).toBe(setups[2])
  })

  // Coercion must not change row membership; the old selector invented repo-derived rows when fields changed.
  it('preserves row count and order', () => {
    const setups = [makeSetup({ repoId: null }), makeSetup({ id: 'setup-2' })]
    expect(normalizeProjectHostSetupRows(setups).map((setup) => setup.id)).toEqual([
      'setup-1',
      'setup-2'
    ])
  })

  it('treats a non-array as empty', () => {
    // JSON models persisted non-array input the declared parameter type cannot express.
    const notAnArray: never[] = JSON.parse('null')
    expect(normalizeProjectHostSetupRows(notAnArray)).toEqual([])
    expect(normalizeProjectRows(notAnArray)).toEqual([])
  })
})
