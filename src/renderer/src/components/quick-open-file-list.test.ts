import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../shared/worktree/types'
import { buildExcludePathPrefixes } from '../../../shared/quick-open/quick-open-filter'
import { getNestedWorktreeExcludeRequest } from './quick-open-file-list-target'
import { getNestedWorktreeExcludePaths } from './quick-open-nested-worktrees'

function makeWorktree(id: string, path: string): Worktree {
  return {
    id,
    repoId: 'repo-1',
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    path,
    head: 'HEAD',
    branch: 'main',
    isBare: false,
    isMainWorktree: false
  }
}

describe('quick-open nested worktree excludes', () => {
  it('excludes nested forward-slash UNC worktrees from Quick Open scans', () => {
    expect(
      getNestedWorktreeExcludePaths('root', '//Server/Share/Repo', [
        makeWorktree('root', '//Server/Share/Repo'),
        makeWorktree('nested', '//server/share/repo/packages/app'),
        makeWorktree('sibling', '//server/share/repo2')
      ])
    ).toEqual(['//server/share/repo/packages/app'])
  })

  it('keeps newline-containing nested worktree paths intact for listFiles requests', () => {
    const request = getNestedWorktreeExcludeRequest('root', '/tmp/repo', [
      makeWorktree('root', '/tmp/repo'),
      makeWorktree('nested', '/tmp/repo/linked\nworktree')
    ])

    expect(request.paths).toEqual(['/tmp/repo/linked\nworktree'])
    expect(request.key).toBe('["/tmp/repo/linked\\nworktree"]')
    expect(buildExcludePathPrefixes('/tmp/repo', request.paths)).toEqual(['linked\nworktree'])
  })
})
