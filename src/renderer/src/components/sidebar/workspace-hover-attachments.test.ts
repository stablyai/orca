import { describe, expect, it } from 'vitest'
import type { Worktree, WorkspaceAttachment } from '../../../../shared/worktree/types'
import { getWorkspaceAttachmentKey } from '../../../../shared/workspace-attachment-normalization'
import { getWorkspaceHoverAttachments } from './workspace-hover-attachments'
const workspace: Worktree = {
  id: 'repo::/repo/feature',
  repoId: 'repo',
  path: '/repo/feature',
  displayName: 'Feature',
  branch: 'feature',
  head: 'abc',
  isBare: false,
  isMainWorktree: false,
  isArchived: false,
  isPinned: false,
  isUnread: false,
  sortOrder: 0,
  lastActivityAt: 1,
  comment: '',
  linkedIssue: null,
  linkedLinearIssue: null,
  linkedPR: 57
}
const local: WorkspaceAttachment = {
  provider: 'github',
  type: 'pr',
  number: 57,
  url: 'https://github.com/acme/orca/pull/57'
}
const other: WorkspaceAttachment = { ...local, url: 'https://github.com/other/orca/pull/57' }
describe('source-safe linked hover details', () => {
  it('uses matching review URL to disambiguate the same number across repositories', () => {
    const result = getWorkspaceHoverAttachments(
      { ...workspace, linkedItems: [other, local] },
      {
        review: {
          provider: 'github',
          number: 57,
          title: 'Local review',
          url: local.url,
          status: 'success'
        }
      }
    )
    expect(result.activeKey).toBe(getWorkspaceAttachmentKey(local))
    expect(result.items[0]?.title).toBeUndefined()
    expect(result.items[1]?.title).toBe('Local review')
  })
  it('does not guess active checks or assign cached titles when the source is unresolved', () => {
    const result = getWorkspaceHoverAttachments(
      { ...workspace, linkedItems: [other, local] },
      { review: { provider: 'github', number: 57, title: 'Unknown review' } }
    )
    expect(result.activeKey).toBeNull()
    expect(result.items.every((item) => !item.title)).toBe(true)
  })
  it('enriches legacy scalar tasks without introducing duplicate references', () => {
    const result = getWorkspaceHoverAttachments(
      { ...workspace, linkedPR: null, linkedIssue: 2, linkedLinearIssue: 'ENG-3' },
      {
        review: null,
        issue: { number: 2, title: 'GitHub task', url: 'https://github.com/acme/orca/issues/2' },
        linearIssue: {
          identifier: 'ENG-3',
          title: 'Linear task',
          url: 'https://linear.app/acme/issue/ENG-3/title'
        }
      }
    )
    expect(result.items).toHaveLength(2)
    expect(result.items.map((item) => item.title)).toEqual(['GitHub task', 'Linear task'])
  })
  it('does not attach review checks to folder workspaces', () => {
    const result = getWorkspaceHoverAttachments(
      { ...workspace, id: 'folder:docs', linkedItems: [local] },
      { review: { provider: 'github', number: 57, title: 'Review', url: local.url } }
    )
    expect(result.activeKey).toBeNull()
  })
  it('does not choose between identical URLs owned by different source contexts', () => {
    const localHost = {
      ...local,
      taskSourceContext: {
        kind: 'task-source' as const,
        provider: 'github' as const,
        projectId: 'repo',
        hostId: 'local' as const
      }
    }
    const otherHost = {
      ...local,
      taskSourceContext: {
        kind: 'task-source' as const,
        provider: 'github' as const,
        projectId: 'repo',
        hostId: 'runtime:other' as const
      }
    }
    const result = getWorkspaceHoverAttachments(
      { ...workspace, linkedItems: [localHost, otherHost] },
      { review: { provider: 'github', number: 57, title: 'Review', url: local.url } }
    )
    expect(result.activeKey).toBeNull()
  })
  it('uses a reference label rather than a review placeholder with no fetched URL', () => {
    const result = getWorkspaceHoverAttachments(
      { ...workspace, linkedItems: [{ provider: 'github', type: 'pr', number: 57 }] },
      { review: { provider: 'github', number: 57, title: 'Unavailable placeholder' } }
    )
    expect(result.items[0]?.title).toBeUndefined()
  })
})
