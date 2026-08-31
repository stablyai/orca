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
})
