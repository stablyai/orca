import { expect, it } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  buildPaletteWorktreeIndex,
  dedupePaletteWorktrees,
  resolvePaletteWorktree
} from '../palette-repo-resolution'
import { buildWorktreePaletteDocuments } from './worktree-palette-document'
import { searchWorktreeDocuments } from './worktree-palette-search'
import '../../../unified-tab-host-ownership'

function makeWorktree(runtimeOwnerEnvironmentId: string, displayName: string): Worktree {
  return {
    id: 'repo::/srv/same',
    repoId: 'repo',
    path: '/srv/same',
    head: 'abc123',
    branch: 'main',
    isBare: false,
    isMainWorktree: false,
    displayName,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    hostId: 'ssh:same-private-target',
    runtimeOwnerEnvironmentId
  }
}

it('keeps same-target SSH worktrees from separate paired runtimes distinct', () => {
  const worktrees = [
    makeWorktree('hub-a', 'AlphaOwner workspace'),
    makeWorktree('hub-b', 'BetaOwner workspace')
  ]
  const repoMap = new Map<string, Repo>()
  const documents = buildWorktreePaletteDocuments(worktrees, { repoMap })
  const results = searchWorktreeDocuments({ worktrees, query: 'workspace', documents, repoMap })
  const alphaResults = searchWorktreeDocuments({
    worktrees,
    query: 'alphaowner',
    documents,
    repoMap
  })
  const betaResults = searchWorktreeDocuments({
    worktrees,
    query: 'betaowner',
    documents,
    repoMap
  })
  const index = buildPaletteWorktreeIndex(worktrees)

  expect(dedupePaletteWorktrees(worktrees)).toHaveLength(2)
  expect(documents.size).toBe(2)
  expect(results.map((result) => result.worktreeHostId)).toEqual(['runtime:hub-a', 'runtime:hub-b'])
  expect(alphaResults.map((result) => result.worktreeHostId)).toEqual(['runtime:hub-a'])
  expect(betaResults.map((result) => result.worktreeHostId)).toEqual(['runtime:hub-b'])
  expect(
    results.map(
      (result) =>
        resolvePaletteWorktree(index, result.worktreeId, result.worktreeHostId)
          ?.runtimeOwnerEnvironmentId
    )
  ).toEqual(['hub-a', 'hub-b'])
})
