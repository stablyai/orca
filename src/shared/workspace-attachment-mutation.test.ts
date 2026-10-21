import { describe, expect, it } from 'vitest'
import type { WorkspaceAttachment } from './worktree/types'
import {
  getWorkspaceAttachments,
  normalizeWorkspaceAttachmentUpdate
} from './workspace-attachments'
import { normalizeWorkspaceAttachments } from './workspace-attachment-normalization'

const legacy: WorkspaceAttachment = { provider: 'github', type: 'pr', number: 42 }
const foreign: WorkspaceAttachment = { ...legacy, url: 'https://github.com/foreign/repo/pull/42' }
const first = { kind: 'observed', tabId: 'first' } as const
const second = { kind: 'observed', tabId: 'second' } as const

describe('source-aware reference deltas', () => {
  it('merges an unknown-source link into the only same-number URL', () => {
    const original = { linkedPR: 42 }
    const base = getWorkspaceAttachments(original)
    const updated = normalizeWorkspaceAttachmentUpdate(original, {
      linkedItemsBase: base,
      linkedItems: [...base, foreign],
      linkedItemsSelectionChanged: false
    })
    expect(updated.linkedItems).toEqual([foreign])
    expect(getWorkspaceAttachments(updated)).toEqual([foreign])
    const removed = normalizeWorkspaceAttachmentUpdate(updated, {
      linkedItemsBase: updated.linkedItems,
      linkedItems: [],
      linkedItemsSelectionChanged: false
    })
    expect(getWorkspaceAttachments(removed)).toEqual([])
  })

  it('keeps an unknown-source link when several same-number URLs could own it', () => {
    const other = { ...legacy, url: 'https://github.com/other/repo/pull/42' }
    expect(getWorkspaceAttachments({ linkedItems: [legacy, foreign, other] })).toEqual([
      legacy,
      foreign,
      other
    ])
  })

  it('merges observations from an unknown-source link into the only same-number URL', () => {
    const original = { linkedItems: [{ ...legacy, origins: [first] }] }
    const updated = normalizeWorkspaceAttachmentUpdate(original, {
      linkedItemsBase: original.linkedItems,
      linkedItems: [...original.linkedItems, foreign]
    })
    expect(updated.linkedItems).toEqual([{ ...foreign, origins: [first] }])
    expect(getWorkspaceAttachments(updated)).toEqual(updated.linkedItems)
  })

  it('does not resurrect a stored unknown-source duplicate removed by an older client', () => {
    const stored = { linkedItems: [legacy, foreign] }
    const updated = normalizeWorkspaceAttachmentUpdate(stored, {
      linkedItemsBase: [{ ...foreign, title: 'Enriched' }],
      linkedItems: []
    })
    expect(getWorkspaceAttachments(updated)).toEqual([])
  })

  it('keeps identical URLs from different source contexts separate', () => {
    const context = (hostId: 'local' | 'runtime:other') => ({
      kind: 'task-source' as const,
      provider: 'github' as const,
      projectId: 'repo',
      hostId
    })
    const local = { ...foreign, title: 'Local', taskSourceContext: context('local') }
    const remote = { ...foreign, title: 'Remote', taskSourceContext: context('runtime:other') }
    const titles = (linkedItems: WorkspaceAttachment[]) =>
      getWorkspaceAttachments({ linkedItems }).map((item) => [
        item.title,
        item.taskSourceContext?.hostId
      ])
    expect(titles([local, remote])).toEqual([
      ['Local', 'local'],
      ['Remote', 'runtime:other']
    ])
    expect(titles([local, foreign])).toEqual([['Local', 'local']])
  })

  it('deduplicates concurrent canonical additions despite different local repository IDs', () => {
    const current = { ...foreign, repoId: 'repo-a', title: 'Fresh', origins: [first] }
    const incoming = { ...foreign, repoId: 'repo-b', origins: [second] }
    const updated = normalizeWorkspaceAttachmentUpdate(
      { linkedItems: [current] },
      {
        linkedItemsBase: [],
        linkedItems: [incoming]
      }
    )
    expect(updated.linkedItems).toEqual([{ ...current, origins: [first, second] }])
  })

  it('does not resurrect canonical links removed during metadata enrichment', () => {
    const updated = normalizeWorkspaceAttachmentUpdate(
      { linkedItems: [] },
      {
        linkedItemsBase: [{ ...foreign, repoId: 'repo-a' }],
        linkedItems: [{ ...foreign, repoId: 'repo-b' }]
      }
    )
    expect(updated.linkedItems).toEqual([])
  })

  it('deduplicates stored canonical references and merges their observations', () => {
    expect(
      getWorkspaceAttachments({
        linkedItems: [
          { ...foreign, repoId: 'repo-a', origins: [first] },
          { ...foreign, repoId: 'repo-b', origins: [second] }
        ]
      })
    ).toEqual([{ ...foreign, repoId: 'repo-a', origins: [first, second] }])
  })

  it('does not duplicate rich compatibility links whose local context differs', () => {
    expect(
      getWorkspaceAttachments({
        linkedItems: [foreign],
        linkedWorkItem: { ...foreign, provider: 'github', title: 'Foreign', url: foreign.url! },
        linkedTaskSourceContext: {
          kind: 'task-source',
          provider: 'github',
          projectId: 'project',
          hostId: 'local',
          providerIdentity: { provider: 'github', owner: 'foreign', repo: 'repo' }
        }
      })
    ).toEqual([foreign])
  })

  it('collapses an unknown-source link through a full collection write', () => {
    const updated = normalizeWorkspaceAttachmentUpdate(
      { linkedPR: 42 },
      { linkedItems: [legacy, foreign] }
    )
    expect(getWorkspaceAttachments(updated)).toEqual([foreign])
  })

  it('returns one reference for a legacy scalar and its matching URL', () => {
    expect(getWorkspaceAttachments({ linkedPR: 42, linkedItems: [foreign] })).toEqual([foreign])
  })

  it('collapses stored unknown-source duplicates on unrelated scalar writes', () => {
    const updated = normalizeWorkspaceAttachmentUpdate(
      { linkedItems: [legacy, foreign] },
      { linkedPR: 99 }
    )
    expect(getWorkspaceAttachments(updated)).toEqual([foreign, { ...legacy, number: 99 }])
  })

  it('carries chained absorptions through to the final survivor in any order', () => {
    const c = { ...legacy, repoId: 'r1', title: 'Legacy', origins: [first] }
    const b = { ...foreign, repoId: 'r1', origins: [second] }
    const a = {
      ...foreign,
      repoId: 'r2',
      taskSourceContext: {
        kind: 'task-source' as const,
        provider: 'github' as const,
        projectId: 'repo',
        hostId: 'local' as const
      }
    }
    for (const order of [
      [c, b, a],
      [a, b, c],
      [b, c, a],
      [a, c, b]
    ]) {
      const result = normalizeWorkspaceAttachments(structuredClone(order))
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({ ...a, title: 'Legacy', origins: [first, second] })
      expect(normalizeWorkspaceAttachments(structuredClone(result))).toEqual(result)
    }
  })
  it('collapses repoId conflicts the same way regardless of input order', () => {
    const items: WorkspaceAttachment[] = [
      foreign,
      { ...foreign, repoId: 'r1' },
      { ...foreign, repoId: 'r2' },
      { ...legacy, repoId: 'r1' }
    ]
    expect(normalizeWorkspaceAttachments(items)).toHaveLength(1)
    expect(normalizeWorkspaceAttachments(items.toReversed())).toHaveLength(1)
  })
})
