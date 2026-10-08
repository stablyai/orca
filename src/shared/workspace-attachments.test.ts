import { describe, expect, it } from 'vitest'
import type { WorkspaceAttachment } from './worktree/types'
import {
  getWorkspaceAttachments,
  normalizeWorkspaceAttachmentUpdate
} from './workspace-attachments'
import {
  getWorkspaceAttachmentKey,
  normalizeWorkspaceAttachments
} from './workspace-attachment-normalization'
import { WorktreeSet } from './rpc-contract/worktree-params'
import { FolderWorkspaceUpdate } from './rpc-contract/folder-workspace-params'

const pr = (number: number): WorkspaceAttachment => ({ provider: 'github', type: 'pr', number })

describe('workspace attachments', () => {
  it('reads old metadata and enriches matching collection entries without duplicate compatibility links', () => {
    const item = {
      ...pr(7),
      title: 'Seven',
      url: 'https://github.com/a/repo/pull/7',
      repoId: 'repo-a'
    }
    expect(getWorkspaceAttachments({ linkedPR: 7, linkedItems: [item] })).toEqual([item])
    expect(getWorkspaceAttachments({ linkedPR: 7, linkedIssue: 8 })).toEqual([
      { provider: 'github', type: 'issue', number: 8 },
      pr(7)
    ])
  })

  it('retains previous attachments when replacing an active scalar and removes only the explicitly unlinked review', () => {
    const first = normalizeWorkspaceAttachmentUpdate({ linkedPR: 7 }, { linkedPR: 8 })
    expect(first.linkedItems).toEqual([pr(7), pr(8)])
    const removed = normalizeWorkspaceAttachmentUpdate(
      { ...first, linkedPR: 8 },
      { linkedPR: null }
    )
    expect(removed.linkedItems).toEqual([pr(7)])
    expect(removed.linkedPR).toBeNull()
  })

  it('uses explicit arrays as authoritative and selects a remaining review after removal', () => {
    const updated = normalizeWorkspaceAttachmentUpdate(
      { linkedPR: 7, linkedItems: [pr(7), pr(8)] },
      { linkedItems: [pr(8)] }
    )
    expect(updated.linkedPR).toBe(8)
    expect(getWorkspaceAttachments(updated)).toEqual([pr(8)])
    const cleared = normalizeWorkspaceAttachmentUpdate(updated, { linkedItems: [] })
    expect(cleared.linkedPR).toBeNull()
    expect(getWorkspaceAttachments(cleared)).toEqual([])
  })

  it('honors a newly selected review across providers', () => {
    const mr: WorkspaceAttachment = { provider: 'gitlab', type: 'mr', number: 20 }
    const updated = normalizeWorkspaceAttachmentUpdate(
      { linkedPR: 7, linkedItems: [pr(7), mr] },
      { linkedItems: [pr(7), mr], linkedGitLabMR: 20 }
    )
    expect(updated.linkedPR).toBeNull()
    expect(updated.linkedGitLabMR).toBe(20)
  })

  it('repairs malformed entries and duplicates while retaining reviews from separate URL/repository scopes', () => {
    const one = { ...pr(7), url: 'https://github.com/A/one/pull/7' }
    const two = { ...pr(7), url: 'https://github.com/A/two/pull/7' }
    expect(
      normalizeWorkspaceAttachments([
        null,
        2,
        {},
        pr(0),
        { ...pr(7), url: 'javascript:alert(1)' },
        one,
        one,
        two
      ])
    ).toEqual([one, two])
    expect(getWorkspaceAttachmentKey(one)).not.toBe(getWorkspaceAttachmentKey(two))
    expect(normalizeWorkspaceAttachments([pr(7), one])).toEqual([one])
  })

  it('keeps Linear issue identities distinct across organizations', () => {
    const one: WorkspaceAttachment = {
      provider: 'linear',
      type: 'issue',
      number: 0,
      identifier: 'APP-1',
      linearOrganizationUrlKey: 'one'
    }
    const two = { ...one, linearOrganizationUrlKey: 'two' }
    expect(normalizeWorkspaceAttachments([one, two])).toEqual([one, two])
  })

  it('leaves unrelated metadata writes untouched', () => {
    const updates = { comment: 'Ready for review' }
    expect(normalizeWorkspaceAttachmentUpdate({ linkedPR: 7 }, updates)).toBe(updates)
  })

  it('clears the other compatibility representation of an unlinked rich task', () => {
    const item = {
      provider: 'github' as const,
      type: 'issue' as const,
      number: 7,
      title: 'Task',
      url: 'https://github.com/a/repo/issues/7'
    }
    const existing = { linkedWorkItem: item, linkedIssue: 7 }
    const removed = normalizeWorkspaceAttachmentUpdate(existing, { linkedIssue: null })
    expect(removed.linkedWorkItem).toBeNull()
    expect(getWorkspaceAttachments({ ...existing, ...removed })).toEqual([])
    const genericRemoved = normalizeWorkspaceAttachmentUpdate(existing, { linkedWorkItem: null })
    expect(genericRemoved.linkedIssue).toBeNull()
    expect(getWorkspaceAttachments({ ...existing, ...genericRemoved })).toEqual([])
  })

  it('accepts optional collections on RPC contracts and rejects invalid collection writes', () => {
    expect(WorktreeSet.parse({ worktree: 'wt' }).linkedItems).toBeUndefined()
    expect(
      WorktreeSet.parse({ worktree: 'wt', linkedItems: [pr(7), pr(8)] }).linkedItems
    ).toHaveLength(2)
    expect(
      WorktreeSet.safeParse({
        worktree: 'wt',
        linkedItems: [{ provider: 'github', type: 'pr', number: -2 }]
      }).success
    ).toBe(false)
    expect(
      WorktreeSet.safeParse({
        worktree: 'wt',
        linkedItems: [
          { ...pr(7), taskSourceContext: { provider: 'jira', projectId: 'wrong', hostId: 'local' } }
        ]
      }).success
    ).toBe(false)
    expect(
      FolderWorkspaceUpdate.parse({
        folderWorkspaceId: 'folder',
        updates: { linkedItems: [pr(7)] }
      }).updates.linkedItems
    ).toEqual([pr(7)])
  })
  it('selects a legacy review exclusively without losing other provider references', () => {
    const mr: WorkspaceAttachment = { provider: 'gitlab', type: 'mr', number: 20 }
    const updated = normalizeWorkspaceAttachmentUpdate(
      { linkedPR: 7, linkedItems: [pr(7)] },
      { linkedGitLabMR: 20 }
    )
    expect(updated).toMatchObject({ linkedPR: null, linkedGitLabMR: 20, linkedItems: [pr(7), mr] })
  })

  it('unlinks only the selected rich source when numbers collide and preserves ambiguous sources', () => {
    const first: WorkspaceAttachment = {
      provider: 'github',
      type: 'issue',
      number: 42,
      title: 'A',
      url: 'https://github.com/a/one/issues/42'
    }
    const second: WorkspaceAttachment = {
      ...first,
      title: 'B',
      url: 'https://github.com/b/two/issues/42'
    }
    const ambiguous = normalizeWorkspaceAttachmentUpdate(
      { linkedItems: [first, second], linkedIssue: 42 },
      { linkedIssue: null }
    )
    expect(ambiguous.linkedItems).toEqual([first, second])
    const selected = normalizeWorkspaceAttachmentUpdate(
      {
        linkedItems: [first, second],
        linkedIssue: 42,
        linkedWorkItem: {
          provider: 'github',
          type: 'issue',
          number: first.number,
          title: first.title ?? 'A',
          url: first.url ?? ''
        }
      },
      { linkedIssue: null }
    )
    expect(selected.linkedItems).toEqual([second])
    expect(selected.linkedWorkItem).toBeNull()
  })

  it('merges a client delta with current host additions without resurrecting concurrent removals', () => {
    const result = normalizeWorkspaceAttachmentUpdate(
      { linkedItems: [pr(2), pr(3)], linkedPR: 3 },
      { linkedItemsBase: [pr(1), pr(2)], linkedItems: [pr(1), pr(4)] }
    )
    expect(result.linkedItems).toEqual([pr(3), pr(4)])
    expect(result).not.toHaveProperty('linkedItemsBase')
    expect(
      WorktreeSet.parse({ worktree: 'wt', linkedItems: [pr(4)], linkedItemsBase: [pr(1)] })
    ).toHaveProperty('linkedItemsBase', [pr(1)])
    expect(
      FolderWorkspaceUpdate.parse({
        folderWorkspaceId: 'f',
        updates: { linkedItems: [pr(4)], linkedItemsBase: [pr(1)] }
      }).updates
    ).toHaveProperty('linkedItemsBase', [pr(1)])
  })

  it('merges concurrent origin edits including explicit removal', () => {
    const a = { kind: 'observed' as const, tabId: 'a' }
    const b = { kind: 'observed' as const, tabId: 'b' }
    const c = { kind: 'observed' as const, tabId: 'c' }
    const result = normalizeWorkspaceAttachmentUpdate(
      { linkedItems: [{ ...pr(1), origins: [a, b] }] },
      { linkedItemsBase: [{ ...pr(1), origins: [a] }], linkedItems: [{ ...pr(1), origins: [c] }] }
    )
    expect(result.linkedItems?.[0].origins).toEqual([b, c])
  })
  it('preserves a concurrent selected review when collection edits did not select another', () => {
    const result = normalizeWorkspaceAttachmentUpdate(
      { linkedItems: [pr(1), pr(2)], linkedPR: 2 },
      {
        linkedItemsBase: [pr(1), pr(2)],
        linkedItems: [pr(1), pr(2), pr(3)],
        linkedPR: 1,
        linkedItemsSelectionChanged: false
      }
    )
    expect(result.linkedPR).toBe(2)
    const intentional = normalizeWorkspaceAttachmentUpdate(
      { linkedItems: [pr(1), pr(2)], linkedPR: 2 },
      {
        linkedItemsBase: [pr(1), pr(2)],
        linkedItems: [pr(1), pr(2)],
        linkedPR: 1,
        linkedItemsSelectionChanged: true
      }
    )
    expect(intentional.linkedPR).toBe(1)
  })

  it('keeps concurrent metadata when only origins were edited', () => {
    const a = { kind: 'observed' as const, tabId: 'a' }
    const result = normalizeWorkspaceAttachmentUpdate(
      { linkedItems: [{ ...pr(1), title: 'Fresh title' }] },
      {
        linkedItemsBase: [{ ...pr(1), title: 'Old title' }],
        linkedItems: [{ ...pr(1), title: 'Old title', origins: [a] }]
      }
    )
    expect(result.linkedItems?.[0]).toMatchObject({ title: 'Fresh title', origins: [a] })
  })
  it('removes a reference enriched after the edit began without removing ambiguous sources', () => {
    const enriched = { ...pr(7), url: 'https://github.com/a/repo/pull/7' }
    const removed = normalizeWorkspaceAttachmentUpdate(
      { linkedItems: [enriched], linkedPR: 7 },
      { linkedItemsBase: [pr(7)], linkedItems: [] }
    )
    expect(removed.linkedItems).toEqual([])
    const other = { ...pr(7), url: 'https://github.com/b/repo/pull/7' }
    expect(
      normalizeWorkspaceAttachmentUpdate(
        { linkedItems: [enriched, other] },
        { linkedItemsBase: [pr(7)], linkedItems: [] }
      ).linkedItems
    ).toEqual([enriched, other])
  })

  it('keeps title and terminal observations when a richer identity replaces a duplicate', () => {
    const origin = { kind: 'observed' as const, tabId: 'terminal' }
    expect(
      normalizeWorkspaceAttachments([
        { ...pr(7), title: 'Seven', origins: [origin] },
        { ...pr(7), url: 'https://github.com/a/repo/pull/7' }
      ])
    ).toEqual([
      { ...pr(7), title: 'Seven', origins: [origin], url: 'https://github.com/a/repo/pull/7' }
    ])
  })

  it('preserves concurrent origins when both editors enrich an unscoped reference', () => {
    const first = { kind: 'observed' as const, tabId: 'first' }
    const second = { kind: 'observed' as const, tabId: 'second' }
    const enriched = { ...pr(7), url: 'https://github.com/a/repo/pull/7' }
    expect(
      normalizeWorkspaceAttachmentUpdate(
        { linkedItems: [{ ...enriched, origins: [first] }] },
        { linkedItemsBase: [pr(7)], linkedItems: [{ ...enriched, origins: [second] }] }
      ).linkedItems
    ).toEqual([{ ...enriched, origins: [first, second] }])
  })

  it('does not resurrect a concurrently removed reference when its identity was enriched', () => {
    expect(
      normalizeWorkspaceAttachmentUpdate(
        { linkedItems: [] },
        {
          linkedItemsBase: [pr(7)],
          linkedItems: [{ ...pr(7), url: 'https://github.com/a/repo/pull/7' }]
        }
      ).linkedItems
    ).toEqual([])
  })

  it('does not overwrite a different scoped replacement with stale enrichment', () => {
    const other = { ...pr(7), url: 'https://github.com/b/repo/pull/7' }
    expect(
      normalizeWorkspaceAttachmentUpdate(
        { linkedItems: [other] },
        {
          linkedItemsBase: [pr(7)],
          linkedItems: [{ ...pr(7), url: 'https://github.com/a/repo/pull/7' }]
        }
      ).linkedItems
    ).toEqual([other])
  })

  it('keeps explicit additional scoped references alongside an enriched original', () => {
    const first = { ...pr(7), url: 'https://github.com/a/repo/pull/7' }
    const other = { ...pr(7), url: 'https://github.com/b/repo/pull/7' }
    expect(
      normalizeWorkspaceAttachmentUpdate(
        { linkedItems: [other] },
        { linkedItemsBase: [pr(7)], linkedItems: [first, other] }
      ).linkedItems
    ).toEqual([other, first])
  })

  it('collapses enrichment chains in one normalization without losing origins', () => {
    const origin = { kind: 'observed' as const, tabId: 'first' }
    const withUrl = { ...pr(7), url: 'https://github.com/a/repo/pull/7' }
    const scoped = {
      ...withUrl,
      taskSourceContext: {
        provider: 'github' as const,
        hostId: 'local' as const,
        projectId: 'project'
      }
    }
    const normalized = normalizeWorkspaceAttachments([
      { ...pr(7), origins: [origin] },
      withUrl,
      scoped
    ])
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({ ...scoped, origins: [origin] })
    expect(normalizeWorkspaceAttachments(normalized)).toEqual(normalized)
  })
  it('keeps an explicitly empty selection when incompatible references remain', () => {
    const mr: WorkspaceAttachment = { provider: 'gitlab', type: 'mr', number: 2 }
    const result = normalizeWorkspaceAttachmentUpdate(
      { linkedItems: [pr(1), mr], linkedPR: 1 },
      {
        linkedItemsBase: [pr(1), mr],
        linkedItems: [mr],
        linkedItemsSelectionChanged: true,
        linkedPR: null,
        linkedGitLabMR: null,
        linkedBitbucketPR: null,
        linkedAzureDevOpsPR: null,
        linkedGiteaPR: null
      }
    )
    expect(result.linkedItems).toEqual([mr])
    expect(result.linkedPR).toBeNull()
    expect(result.linkedGitLabMR).toBeNull()
  })
})
