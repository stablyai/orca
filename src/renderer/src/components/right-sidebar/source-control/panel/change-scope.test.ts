import { describe, expect, it } from 'vitest'
import type {
  GitHistoryItem,
  GitHistoryResult
} from '../../../../../../shared/git/history/git-history-types'
import {
  commitScopeFromPage,
  provesPickedCommitGone,
  summarizeChangeScopeEntries
} from './change-scope'

function item(id: string): GitHistoryItem {
  return { id, parentIds: [], subject: id, message: id }
}

function page(
  ids: string[],
  {
    head = 'h1',
    baseOid,
    hasMore = false
  }: { head?: string; baseOid?: string; hasMore?: boolean } = {}
): GitHistoryResult {
  return {
    items: ids.map(item),
    currentRef: { id: 'refs/heads/feature', name: 'feature', revision: head },
    ...(baseOid
      ? {
          branch: {
            baseRef: { id: 'refs/remotes/origin/main', name: 'origin/main', revision: baseOid },
            ahead: ids.length,
            behind: 0,
            unpushed: 0
          }
        }
      : {}),
    hasIncomingChanges: false,
    hasOutgoingChanges: false,
    hasMore,
    limit: 50
  }
}

function pickFrom(source: GitHistoryResult, id: string) {
  const scope = commitScopeFromPage(item(id), source)
  if (scope.kind !== 'commit') {
    throw new Error('expected a commit scope')
  }
  return scope
}

describe('provesPickedCommitGone', () => {
  const picked = pickFrom(page(['c2', 'c1'], { baseOid: 'b1' }), 'c1')

  it('proves a reset or rebase from a complete page for the current HEAD and base', () => {
    expect(provesPickedCommitGone(picked, page(['c3'], { head: 'h2', baseOid: 'b1' }), 'h2')).toBe(
      true
    )
  })

  it('keeps the pick when a new commit only pushes it off a full page', () => {
    const full = page(['c3', 'c2'], { head: 'h2', baseOid: 'b1', hasMore: true })
    expect(provesPickedCommitGone(picked, full, 'h2')).toBe(false)
  })

  it('keeps the pick when the base moved or the page is for another HEAD', () => {
    expect(provesPickedCommitGone(picked, page(['c3'], { head: 'h2', baseOid: 'b2' }), 'h2')).toBe(
      false
    )
    expect(provesPickedCommitGone(picked, page(['c3'], { head: 'h2', baseOid: 'b1' }), 'h3')).toBe(
      false
    )
    expect(provesPickedCommitGone(picked, page(['c3'], { head: 'h2', baseOid: 'b1' }), null)).toBe(
      false
    )
  })

  it('uses a complete plain HEAD page only for a pick from a plain page', () => {
    const plainPick = pickFrom(page(['c2', 'c1']), 'c1')
    expect(provesPickedCommitGone(plainPick, page(['c3'], { head: 'h2' }), 'h2')).toBe(true)
    expect(provesPickedCommitGone(picked, page(['c3'], { head: 'h2' }), 'h2')).toBe(false)
  })
})

describe('summarizeChangeScopeEntries', () => {
  it('counts a path listed twice once and drops line totals when any row is unknown', () => {
    expect(
      summarizeChangeScopeEntries([
        { path: 'a.ts', added: 2, removed: 1 },
        { path: 'a.ts', added: 3, removed: 0 }
      ])
    ).toEqual({ files: 1, lines: { added: 5, removed: 1 } })
    expect(
      summarizeChangeScopeEntries([{ path: 'a.ts', added: 2, removed: 1 }, { path: 'logo.png' }])
    ).toEqual({ files: 2, lines: null })
  })
})
