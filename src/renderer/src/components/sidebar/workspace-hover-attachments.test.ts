import { describe, expect, it } from 'vitest'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { referenceRepo } from './workspace-reference-fixtures.test-support'
import type { Worktree, WorkspaceAttachment } from '../../../../shared/worktree/types'
import { getWorkspaceAttachmentKey } from '../../../../shared/workspace-attachment-normalization'
import {
  getWorkspaceHoverAttachments,
  getWorkspaceLinkedItemRows,
  getWorkspaceCardAttachments,
  isSavedWorkspaceCardAttachment
} from './workspace-hover-attachments'
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
  it('reuses projections across review status updates without retaining stale links or branch identities', () => {
    const worktree = { ...workspace, linkedPR: null, linkedItems: [other] }
    const review = { provider: 'github' as const, number: 57, title: 'Branch PR', url: local.url }
    const first = getWorkspaceCardAttachments(worktree, review)
    expect(getWorkspaceCardAttachments(worktree, { ...review, status: 'failure' })).toBe(first)
    expect(isSavedWorkspaceCardAttachment(worktree, other)).toBe(true)
    expect(isSavedWorkspaceCardAttachment(worktree, local)).toBe(false)
    expect(getWorkspaceCardAttachments(worktree, null)).toEqual([other])
    expect(getWorkspaceCardAttachments(worktree, review)).toBe(first)
    const renamed = getWorkspaceCardAttachments(worktree, { ...review, title: 'Renamed PR' })
    expect(renamed[1]?.title).toBe('Renamed PR')
    const moved = getWorkspaceCardAttachments(worktree, {
      ...review,
      url: 'https://github.com/new/orca/pull/57'
    })
    expect(moved[1]?.url).toBe('https://github.com/new/orca/pull/57')
    const updated = { ...worktree, linkedItems: [local] }
    expect(getWorkspaceCardAttachments(updated, review)).toEqual([local])
    expect(isSavedWorkspaceCardAttachment(updated, other)).toBe(false)
    expect(isSavedWorkspaceCardAttachment(updated, local)).toBe(true)
  })
  it.each(['github', 'gitlab'] as const)(
    'keeps a discovered %s review alongside an older observed reference without persisting it',
    (provider) => {
      const saved = { ...local, origins: [{ kind: 'observed' as const, tabId: 'terminal' }] }
      const worktree = { ...workspace, linkedPR: null, linkedItems: [saved] }
      const review = {
        provider,
        number: 58,
        title: 'Current branch review',
        url:
          provider === 'github'
            ? 'https://github.com/acme/orca/pull/58'
            : 'https://gitlab.example.com/team/orca/-/merge_requests/58',
        status: 'failure' as const
      }
      const result = getWorkspaceHoverAttachments(worktree, { review })
      expect(result.items.map((item) => item.number)).toEqual([57, 58])
      expect(result.liveMatched).toEqual([false, true])
      const rows = getWorkspaceLinkedItemRows(worktree, { review }, undefined)
      expect(rows[0]).toMatchObject({ item: { number: 58 }, live: review })
      expect(rows[1]).toMatchObject({ item: saved, live: null })
      expect(worktree.linkedItems).toEqual([saved])
      expect(worktree.linkedPR).toBeNull()
    }
  )
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
    expect(result.items).toHaveLength(2)
    expect(result.activeKey).toBe(getWorkspaceAttachmentKey(local))
    expect(result.items[0]?.title).toBeUndefined()
    expect(result.items[1]?.title).toBe('Local review')
  })
  it('keeps equal-numbered reviews from different repositories separate', () => {
    const review = {
      provider: 'github' as const,
      number: 57,
      title: 'Branch review',
      url: local.url
    }
    const rows = getWorkspaceLinkedItemRows(
      { ...workspace, linkedPR: null, linkedItems: [other] },
      { review },
      undefined
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ item: local, live: review })
    expect(rows[1]).toMatchObject({ item: other, live: null })
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
  it('uses only the eligible source when identical URLs belong to different hosts', () => {
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
      { review: { provider: 'github', number: 57, title: 'Review', url: local.url } },
      referenceRepo
    )
    expect(result.activeKey).toBe(getWorkspaceAttachmentKey(localHost))
    expect(result.liveMatched).toEqual([true, false])
  })
  const source: TaskSourceContext = {
    kind: 'task-source',
    provider: 'github',
    projectId: 'repo',
    hostId: 'local',
    repoId: 'repo'
  }
  it.each([
    { hostId: 'runtime:other' as const },
    { repoId: 'other-repo' },
    { accountLabel: 'other-account' },
    { providerIdentity: { provider: 'github' as const, owner: 'other', repo: 'orca' } }
  ])('keeps branch state separate from an ineligible source: %j', (foreignSource) => {
    const saved: WorkspaceAttachment = {
      provider: 'github',
      type: 'pr',
      number: 57,
      taskSourceContext: { ...source, ...foreignSource }
    }
    const review = {
      provider: 'github' as const,
      number: 57,
      title: 'Branch review',
      url: local.url,
      status: 'failure' as const
    }
    for (const linkedPR of [null, 57]) {
      for (const url of [undefined, local.url]) {
        const foreign = { ...saved, url }
        const worktree = { ...workspace, linkedPR, linkedItems: [foreign] }
        const projection = getWorkspaceHoverAttachments(worktree, { review }, referenceRepo)
        expect(projection.items).toHaveLength(2)
        expect(projection.items[0]?.taskSourceContext).toMatchObject({
          ...source,
          ...foreignSource
        })
        expect(projection.items[0]?.url).toBe(url)
        expect(projection.items[0]?.title).toBeUndefined()
        expect(projection.liveMatched).toEqual([false, true])
        expect(projection.activeKey).toBe(getWorkspaceAttachmentKey(local))
        const rows = getWorkspaceLinkedItemRows(worktree, { review }, undefined, referenceRepo)
        expect(rows[0]).toMatchObject({ item: local, live: review })
        expect(rows[1]?.live).toBeNull()
        expect(rows[1]?.url).toBe(url)
      }
    }
  })
  it('deduplicates eligible URL-less references and invalidates eligibility when the repo changes', () => {
    const saved: WorkspaceAttachment = {
      provider: 'github',
      type: 'pr',
      number: 57,
      taskSourceContext: source
    }
    const worktree = { ...workspace, linkedItems: [saved] }
    const review = { provider: 'github' as const, number: 57, title: 'Branch PR', url: local.url }
    expect(getWorkspaceCardAttachments(worktree, review, referenceRepo)).toMatchObject([saved])
    const rows = getWorkspaceLinkedItemRows(worktree, { review }, undefined, referenceRepo)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ live: review, url: local.url })
    expect(
      getWorkspaceCardAttachments(worktree, review, {
        ...referenceRepo,
        executionHostId: 'runtime:other'
      })
    ).toHaveLength(2)
    expect(getWorkspaceCardAttachments(worktree, review, referenceRepo)).toMatchObject([saved])
  })
  it('assigns live checks to the eligible URL-less reference beside a foreign reference', () => {
    const saved: WorkspaceAttachment = {
      provider: 'github',
      type: 'pr',
      number: 57,
      taskSourceContext: source
    }
    const foreign = { ...saved, taskSourceContext: { ...source, repoId: 'other-repo' } }
    const review = { provider: 'github' as const, number: 57, title: 'Branch PR', url: local.url }
    const worktree = { ...workspace, linkedItems: [saved, foreign] }
    const rows = getWorkspaceLinkedItemRows(worktree, { review }, undefined, referenceRepo)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.live).toBeNull()
    expect(rows[1]?.live).toBe(review)
  })
  it.each(['github', 'gitlab'] as const)(
    'deduplicates eligible %s references on their owning remote host',
    (provider) => {
      const repo = {
        ...referenceRepo,
        executionHostId: 'runtime:owner' as const,
        ghAccount: { host: 'github.com', user: 'owner' },
        ...(provider === 'gitlab'
          ? {
              gitRemoteIdentity: {
                canonicalKey: 'gitlab.example.com/team/orca',
                remoteName: 'origin',
                remoteUrl: 'https://gitlab.example.com/team/orca.git'
              }
            }
          : {})
      }
      const saved: WorkspaceAttachment = {
        provider,
        type: provider === 'gitlab' ? 'mr' : 'pr',
        number: 57,
        taskSourceContext: {
          ...source,
          provider,
          hostId: 'runtime:owner',
          accountLabel: provider === 'github' ? 'owner' : undefined
        }
      }
      const worktree = {
        ...workspace,
        hostId: 'runtime:owner' as const,
        linkedPR: provider === 'github' ? 57 : null,
        linkedGitLabMR: provider === 'gitlab' ? 57 : null,
        linkedItems: [saved]
      }
      const review = {
        provider,
        number: 57,
        title: 'Remote branch review',
        url:
          provider === 'github'
            ? local.url
            : 'https://gitlab.example.com/team/orca/-/merge_requests/57'
      }
      const rows = getWorkspaceLinkedItemRows(worktree, { review }, undefined, repo)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.live).toBe(review)
      expect(rows[0]?.item.taskSourceContext?.hostId).toBe('runtime:owner')
    }
  )
  it('uses a reference label rather than a review placeholder with no fetched URL', () => {
    const result = getWorkspaceHoverAttachments(
      { ...workspace, linkedItems: [{ provider: 'github', type: 'pr', number: 57 }] },
      { review: { provider: 'github', number: 57, title: 'Unavailable placeholder' } }
    )
    expect(result.items[0]?.title).toBeUndefined()
  })
})
