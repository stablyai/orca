// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const { DeleteWorktreeLineageNotice } = await import('./DeleteWorktreeLineageNotice')

function child(id: string, repoId: string): Worktree {
  return {
    id: `${repoId}::/ws/${id}`,
    repoId,
    path: `/ws/${id}`,
    displayName: id,
    head: 'abc',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

describe('DeleteWorktreeLineageNotice', () => {
  it('names the repo only of descendants outside the parent repo (#8886)', () => {
    const markup = renderToStaticMarkup(
      <DeleteWorktreeLineageNotice
        descendants={[child('same-child', 'repo-a'), child('cross-child', 'repo-b')]}
        dirtyChangeCountsByWorktreeId={new Map()}
        parentRepoId="repo-a"
        repoMap={
          new Map([
            ['repo-a', { displayName: 'alpha-repo', badgeColor: '#111111' }],
            ['repo-b', { displayName: 'beta-repo', badgeColor: '#222222' }]
          ])
        }
      />
    )

    expect(markup).toContain('beta-repo')
    expect(markup).not.toContain('alpha-repo')
  })
})
