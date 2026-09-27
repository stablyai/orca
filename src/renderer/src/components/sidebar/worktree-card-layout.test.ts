import { describe, expect, it } from 'vitest'
import {
  selectWorktreeCardDisplayMode,
  selectWorktreeCardIdentity,
  selectWorktreeCardLayout
} from './worktree-card-layout'
import { DEFAULT_WORKTREE_CARD_PROPERTIES } from '../../../../shared/worktree/card-properties'
import { makeRepo, makeWorktree } from './worktree-list-lineage-card-test-fixtures'

const base: Parameters<typeof selectWorktreeCardLayout>[0] = {
  newCardStyle: false,
  compactCards: false,
  hasRepo: true,
  inPinnedSection: false,
  hideRepoBadge: false,
  isFolder: false,
  detachedHead: false,
  branch: 'feature',
  displayName: 'Feature',
  folderMetaRowContent: false,
  showIdentityInNewCard: false,
  conflictOperation: null,
  cacheVisible: false,
  hasDetails: false,
  hasPorts: false,
  showInlineAgentList: true,
  showLineageChildChip: false,
  hasRemoteBranchConflict: false
}

describe('shared worktree presentation shape', () => {
  it.each([
    [
      {},
      { showRepoBadgeInMetaRow: true, showBranch: true, hasMetaRow: true, titleOnlyCard: false }
    ],
    [
      { inPinnedSection: true },
      { showPinnedRepoIcon: true, showRepoBadgeInMetaRow: false, showBranch: true }
    ],
    [{ hideRepoBadge: true }, { showRepoBadgeInMetaRow: false, hasMetaRow: true }],
    [
      { newCardStyle: true },
      {
        showInlineRepoBadge: true,
        showRepoBadgeInMetaRow: false,
        showBranch: false,
        hasMetaRow: false,
        titleOnlyCard: false
      }
    ],
    [{ newCardStyle: true, showIdentityInNewCard: true }, { hasMetaRow: true }],
    [
      { compactCards: true, displayName: 'feature' },
      { showBranch: false, hasMetaRow: false }
    ],
    [
      { compactCards: true, conflictOperation: 'rebase' },
      { showConflictOperationBadge: false, hasMetaRow: false }
    ],
    [
      { compactCards: true, conflictOperation: 'merge' },
      { showConflictOperationBadge: true, hasMetaRow: true }
    ],
    [
      { newCardStyle: true, showInlineAgentList: false },
      { hasMetaRow: false, titleOnlyCard: true }
    ],
    [
      { newCardStyle: true, showInlineAgentList: false, showLineageChildChip: true },
      { titleOnlyCard: false }
    ]
  ] as const)('preserves visible lane policy for %j', (changes, expected) => {
    expect(selectWorktreeCardLayout({ ...base, ...changes })).toMatchObject(expected)
  })
  it('keeps detail and port indicators within already-present lanes in the admitted styles', () => {
    for (const newCardStyle of [false, true]) {
      const quiet = selectWorktreeCardLayout({ ...base, newCardStyle })
      const populated = selectWorktreeCardLayout({
        ...base,
        newCardStyle,
        hasDetails: true,
        hasPorts: true
      })
      expect(populated.hasMetaRow).toBe(quiet.hasMetaRow)
      expect(populated.titleOnlyCard).toBe(quiet.titleOnlyCard)
      expect(populated.showTitleRowIndicators).toBe(newCardStyle)
      expect(populated.showMetaRowDetails).toBe(!newCardStyle)
    }
  })
  it('uses actual default properties and preserves new style precedence over compact preference', () => {
    const worktree = makeWorktree({
      id: 'w',
      displayName: 'w',
      branch: 'refs/heads/feature',
      sortOrder: 0,
      instanceId: 'w'
    })
    expect(
      selectWorktreeCardIdentity({
        worktree,
        repo: makeRepo(),
        newCardStyle: true,
        cardProps: DEFAULT_WORKTREE_CARD_PROPERTIES,
        hasProjectGroups: false
      })
    ).toMatchObject({ branch: 'feature', showIdentityInNewCard: false, isFolder: false })
    expect(selectWorktreeCardDisplayMode(true, true, DEFAULT_WORKTREE_CARD_PROPERTIES)).toEqual({
      compactCards: false,
      showInlineAgentList: true
    })
    expect(selectWorktreeCardDisplayMode(false, true, DEFAULT_WORKTREE_CARD_PROPERTIES)).toEqual({
      compactCards: true,
      showInlineAgentList: false
    })
  })
})
