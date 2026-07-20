import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProjectGroup, Repo } from '../../../shared/types'
import { resolveProjectGroupComposerTarget } from './useComposerState'

const HOOK_SOURCE = readFileSync(join(__dirname, 'useComposerState.ts'), 'utf8')

function hookSourceBetween(startMarker: string, endMarker: string): string {
  const start = HOOK_SOURCE.indexOf(startMarker)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = HOOK_SOURCE.indexOf(endMarker, start)
  expect(end).toBeGreaterThan(start)
  return HOOK_SOURCE.slice(start, end)
}

function makeProjectGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-1',
    name: 'platform',
    parentPath: '/workspace/platform',
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'app',
    path: '/workspace/platform/app',
    displayName: 'app',
    badgeColor: '#999999',
    addedAt: 1,
    kind: 'git',
    projectGroupId: 'group-1',
    ...overrides
  }
}

describe('resolveProjectGroupComposerTarget', () => {
  it('resolves a folder-backed group to its first source project', () => {
    const group = makeProjectGroup()
    const repo = makeRepo()

    expect(
      resolveProjectGroupComposerTarget({
        projectGroupId: 'group-1',
        projectGroups: [group],
        repos: [repo]
      })
    ).toEqual({ projectGroup: group, sourceRepoId: 'app' })
  })

  it('resolves a group whose member projects are gone, with an empty source repo', () => {
    const group = makeProjectGroup()

    // Why: members can be removed while a selection is in flight; the folder
    // target itself stays valid, as handleProjectChange has always allowed.
    expect(
      resolveProjectGroupComposerTarget({
        projectGroupId: 'group-1',
        projectGroups: [group],
        repos: []
      })
    ).toEqual({ projectGroup: group, sourceRepoId: '' })
  })

  it('rejects a group that is no longer known', () => {
    expect(
      resolveProjectGroupComposerTarget({
        projectGroupId: 'group-gone',
        projectGroups: [makeProjectGroup()],
        repos: [makeRepo()]
      })
    ).toBeNull()
  })

  it('rejects a group with no folder root, which cannot back a workspace', () => {
    expect(
      resolveProjectGroupComposerTarget({
        projectGroupId: 'group-1',
        projectGroups: [makeProjectGroup({ parentPath: '   ' })],
        repos: [makeRepo()]
      })
    ).toBeNull()
  })
})

describe('selectAddedProjectGroup', () => {
  it('resolves the imported group from live store state, not the render closure', () => {
    const section = hookSourceBetween('const selectAddedProjectGroup = useCallback', 'return true')
    // Why: the group and its projects land during the import this callback
    // completes, so a closure read would miss both and silently fall back.
    expect(section).toContain('useAppStore.getState()')
    expect(section).toContain('projectGroups: state.projectGroups')
    expect(section).toContain('repos: state.repos')
  })

  it('selects the group through the same path as a manual combobox pick', () => {
    const applyCall = 'applyProjectGroupSelection(selection.projectGroup, selection.sourceRepoId)'
    // Why: sharing applyProjectGroupSelection keeps the import handoff
    // behaviorally identical to picking the group in the project combobox,
    // whose state resets the host-context-boundaries suite already pins.
    expect(
      hookSourceBetween('const selectAddedProjectGroup = useCallback', 'return true')
    ).toContain(applyCall)
    expect(
      hookSourceBetween('const handleProjectChange = useCallback', 'const selectAddedProjectRepo')
    ).toContain(applyCall)
  })

  it('marks the initial group applied so a late initial selection cannot override the import', () => {
    const section = hookSourceBetween('const selectAddedProjectGroup = useCallback', 'return true')
    expect(section).toContain('initialProjectGroupAppliedRef.current = true')
  })

  it('bails out before applying any composer state when the group is not selectable', () => {
    const section = hookSourceBetween('const selectAddedProjectGroup = useCallback', 'return true')
    expect(section.indexOf('return false')).toBeGreaterThanOrEqual(0)
    expect(section.indexOf('applyProjectGroupSelection')).toBeGreaterThan(
      section.indexOf('return false')
    )
  })
})
