import { describe, expect, it } from 'vitest'
import {
  MAX_WORKSPACE_DOC_HISTORY_ENTRIES,
  normalizeWorkspaceDocHistoryEntries,
  normalizeWorkspaceDocHistoryTitle,
  type WorkspaceDocHistoryEntry
} from './workspace-doc-history'

const DOC = { kind: 'workspace-doc' as const, worktreeId: 'wt-1', filePath: '/repo/a.html' }

function entry(overrides: Partial<WorkspaceDocHistoryEntry> = {}): WorkspaceDocHistoryEntry {
  return { docLocation: DOC, title: 'A', lastVisitedAt: 1, visitCount: 1, ...overrides }
}

describe('normalizeWorkspaceDocHistoryEntries', () => {
  it('dedupes on the document, keeping the most recent visit', () => {
    const entries = normalizeWorkspaceDocHistoryEntries([
      entry({ title: 'Old', lastVisitedAt: 1 }),
      entry({ title: 'New', lastVisitedAt: 5 })
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]?.title).toBe('New')
  })

  it('caps by recency, not input order', () => {
    const oversized = Array.from({ length: MAX_WORKSPACE_DOC_HISTORY_ENTRIES + 10 }, (_, i) =>
      entry({
        docLocation: { ...DOC, filePath: `/repo/${i}.html` },
        lastVisitedAt: i
      })
    )
    const entries = normalizeWorkspaceDocHistoryEntries(oversized)
    expect(entries).toHaveLength(MAX_WORKSPACE_DOC_HISTORY_ENTRIES)
    // The oldest rows are the dropped ones.
    expect(entries.at(-1)?.lastVisitedAt).toBe(10)
  })

  it('drops malformed rows and fences a url-as-title back to the file name', () => {
    const entries = normalizeWorkspaceDocHistoryEntries([
      entry({ title: `orca-preview://${'a'.repeat(32)}/a.html` }),
      {
        docLocation: { kind: 'workspace-doc', worktreeId: '', filePath: '' },
        title: 'x',
        lastVisitedAt: 2,
        visitCount: 1
      }
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]?.title).toBe('a.html')
  })

  it('title fence falls back to the file for empty titles', () => {
    expect(normalizeWorkspaceDocHistoryTitle('', DOC)).toBe('a.html')
    expect(normalizeWorkspaceDocHistoryTitle('Report', DOC)).toBe('Report')
  })
  it('indexes document identity while deduplicating a large legacy history', () => {
    let reads = 0
    const entries = Array.from({ length: 10_000 }, (_, i) =>
      entry({
        docLocation: {
          kind: 'workspace-doc',
          get worktreeId() {
            reads++
            return 'wt-1'
          },
          filePath: `/repo/${i % 99}.html`
        },
        lastVisitedAt: i
      })
    )
    const result = normalizeWorkspaceDocHistoryEntries(entries)
    expect(reads).toBeLessThanOrEqual(20_000)
    expect(result).toHaveLength(99)
    expect(result.map((row) => row.lastVisitedAt)).toEqual(
      Array.from({ length: 99 }, (_, i) => 9999 - i)
    )
  })

  it('keeps workspace and file identity separate, including separator-like text', () => {
    const locations = [
      { kind: 'workspace-doc' as const, worktreeId: 'a::b', filePath: 'c' },
      { kind: 'workspace-doc' as const, worktreeId: 'a', filePath: 'b::c' },
      { kind: 'workspace-doc' as const, worktreeId: 'a', filePath: 'B::c' }
    ]
    const entries = locations.map((docLocation) => entry({ docLocation }))
    expect(normalizeWorkspaceDocHistoryEntries(entries)).toEqual(entries)
  })
})
