import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import type {
  WorkspaceSpaceAnalysis,
  WorkspaceSpaceWorktree
} from '../../../shared/workspace-space-types'
import {
  getConcealedRepoIdsFromState,
  getShownReposFromState,
  getShownWorkspaceSpaceAnalysisFromState,
  omitConcealedRepoKeys,
  withoutConcealedOnlyProjectGroups
} from './concealed-repo-selector'

const repo = (id: string, extra: Partial<Repo> = {}): Repo => ({
  id,
  path: `/tmp/${id}`,
  displayName: id,
  badgeColor: '#000000',
  addedAt: 0,
  ...extra
})

const group = (id: string, parentGroupId: string | null = null): ProjectGroup => ({
  id,
  name: id,
  parentPath: null,
  parentGroupId,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0
})

describe('concealed repo selectors', () => {
  const repos = [repo('open'), repo('secret', { incognito: true })]

  it('keeps identity when nothing is concealed', () => {
    const plain = [repo('open')]
    expect(getShownReposFromState({ repos: plain, incognitoProjectsUnlocked: false })).toBe(plain)
    expect(getShownReposFromState({ repos, incognitoProjectsUnlocked: true })).toBe(repos)
  })

  it('drops locked incognito repos with a stable result', () => {
    const state = { repos, incognitoProjectsUnlocked: false }
    const shown = getShownReposFromState(state)
    expect(shown.map((r) => r.id)).toEqual(['open'])
    expect(getShownReposFromState(state)).toBe(shown)
    expect(getConcealedRepoIdsFromState(state)).toBe(getConcealedRepoIdsFromState(state))
  })

  it('hides a project group whose only members are concealed repos', () => {
    const groups = [group('secret-only'), group('mixed'), group('with-folder')]
    const members = [
      repo('s1', { incognito: true, projectGroupId: 'secret-only' }),
      repo('s2', { incognito: true, projectGroupId: 'mixed' }),
      repo('o1', { projectGroupId: 'mixed' }),
      repo('s3', { incognito: true, projectGroupId: 'with-folder' })
    ]
    const concealed = new Set(['s1', 's2', 's3'])
    const visible = withoutConcealedOnlyProjectGroups(
      groups,
      members,
      [{ projectGroupId: 'with-folder' }],
      concealed
    )
    expect(visible.map((g) => g.id)).toEqual(['mixed', 'with-folder'])
  })

  it('hides a parent group whose only content is a concealed-only child group', () => {
    const groups = [
      group('parent'),
      group('secret-child', 'parent'),
      group('busy-parent'),
      group('secret-sibling', 'busy-parent'),
      group('empty-child', 'busy-parent'),
      group('empty')
    ]
    const members = [
      repo('s1', { incognito: true, projectGroupId: 'secret-child' }),
      repo('s2', { incognito: true, projectGroupId: 'secret-sibling' })
    ]
    const visible = withoutConcealedOnlyProjectGroups(groups, members, [], new Set(['s1', 's2']))
    expect(visible.map((g) => g.id)).toEqual(['busy-parent', 'empty-child', 'empty'])
  })

  it('omits concealed repo keys only when present', () => {
    const byRepo = { open: [1], secret: [2] }
    expect(omitConcealedRepoKeys(byRepo, new Set(['missing']))).toBe(byRepo)
    expect(omitConcealedRepoKeys(byRepo, new Set(['secret']))).toEqual({ open: [1] })
  })

  it('drops locked incognito repos from the space analysis and recomputes its totals', () => {
    const row = (repoId: string, sizeBytes: number): WorkspaceSpaceWorktree => ({
      worktreeId: `${repoId}::/w`,
      repoId,
      repoDisplayName: repoId,
      repoPath: `/tmp/${repoId}`,
      displayName: repoId,
      path: '/w',
      branch: 'main',
      isMainWorktree: false,
      isRemote: false,
      isSparse: false,
      canDelete: true,
      lastActivityAt: 0,
      status: 'ok',
      error: null,
      scannedAt: 0,
      sizeBytes,
      reclaimableBytes: sizeBytes,
      skippedEntryCount: 0,
      topLevelItems: [],
      omittedTopLevelItemCount: 0,
      omittedTopLevelSizeBytes: 0
    })
    const summary = (repoId: string, sizeBytes: number) => ({
      repoId,
      displayName: repoId,
      path: `/tmp/${repoId}`,
      isRemote: false,
      worktreeCount: 1,
      scannedWorktreeCount: 1,
      unavailableWorktreeCount: 0,
      totalSizeBytes: sizeBytes,
      reclaimableBytes: sizeBytes,
      error: null
    })
    const analysis: WorkspaceSpaceAnalysis = {
      scannedAt: 0,
      totalSizeBytes: 30,
      reclaimableBytes: 30,
      worktreeCount: 2,
      scannedWorktreeCount: 2,
      unavailableWorktreeCount: 0,
      repos: [summary('open', 10), summary('secret', 20)],
      worktrees: [row('open', 10), row('secret', 20)]
    }

    const locked = { repos, incognitoProjectsUnlocked: false, workspaceSpaceAnalysis: analysis }
    const shown = getShownWorkspaceSpaceAnalysisFromState(locked)
    expect(shown).toMatchObject({ totalSizeBytes: 10, reclaimableBytes: 10, worktreeCount: 1 })
    expect(JSON.stringify(shown)).not.toContain('secret')
    expect(getShownWorkspaceSpaceAnalysisFromState(locked)).toBe(shown)
    expect(
      getShownWorkspaceSpaceAnalysisFromState({ ...locked, incognitoProjectsUnlocked: true })
    ).toBe(analysis)
  })
})
