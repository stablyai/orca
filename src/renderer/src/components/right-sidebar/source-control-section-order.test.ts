import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../shared/types'
import {
  buildSourceControlDisplaySections,
  getConflictReviewEntries,
  getSourceControlSectionViewAction,
  mergeUntrackedIntoChanges,
  SOURCE_CONTROL_GROUP_ORDER,
  splitPinnedSourceControlConflicts,
  type SourceControlEntryGroups
} from './source-control-section-order'

function entry(partial: Partial<GitStatusEntry> & { path: string }): GitStatusEntry {
  return {
    area: 'unstaged',
    status: 'modified',
    ...partial
  }
}

function groups(partial: Partial<SourceControlEntryGroups>): SourceControlEntryGroups {
  return {
    staged: [],
    unstaged: [],
    untracked: [],
    ...partial
  }
}

describe('SOURCE_CONTROL_GROUP_ORDER', () => {
  it('follows the edit, stage, commit workflow', () => {
    expect(SOURCE_CONTROL_GROUP_ORDER).toEqual(['unstaged', 'staged', 'untracked'])
  })
})

describe('mergeUntrackedIntoChanges', () => {
  it('folds untracked entries into Changes without changing their Git area', () => {
    const unstaged = entry({ area: 'unstaged', path: 'changed.ts' })
    const untracked = entry({ area: 'untracked', path: 'new.ts', status: 'untracked' })
    const merged = mergeUntrackedIntoChanges(
      groups({ unstaged: [unstaged], untracked: [untracked] })
    )

    expect(merged.unstaged).toEqual([unstaged, untracked])
    expect(merged.untracked).toEqual([])
    expect(merged.unstaged[1]?.area).toBe('untracked')
  })
})

describe('buildSourceControlDisplaySections', () => {
  it('uses the fixed workflow order for normal sections', () => {
    const sections = buildSourceControlDisplaySections(
      groups({
        staged: [entry({ area: 'staged', path: 'staged.ts' })],
        unstaged: [entry({ area: 'unstaged', path: 'changed.ts' })],
        untracked: [entry({ area: 'untracked', path: 'new.ts', status: 'untracked' })]
      }),
      SOURCE_CONTROL_GROUP_ORDER
    )

    expect(sections.map((section) => section.id)).toEqual(['unstaged', 'staged', 'untracked'])
  })

  it('keeps conflicts pinned before the configured normal order', () => {
    const sections = buildSourceControlDisplaySections(
      groups({
        staged: [entry({ area: 'staged', path: 'staged.ts' })],
        unstaged: [
          entry({
            area: 'unstaged',
            path: 'conflict.ts',
            conflictKind: 'both_modified',
            conflictStatus: 'unresolved'
          }),
          entry({ area: 'unstaged', path: 'changed.ts' })
        ],
        untracked: [entry({ area: 'untracked', path: 'new.ts', status: 'untracked' })]
      }),
      SOURCE_CONTROL_GROUP_ORDER
    )

    expect(sections.map((section) => section.id)).toEqual([
      'conflicts',
      'unstaged',
      'staged',
      'untracked'
    ])
  })

  it('pins conflict rows and removes them from the normal Changes section', () => {
    const unresolved = entry({
      area: 'unstaged',
      path: 'conflict.ts',
      conflictStatus: 'unresolved'
    })
    const resolved = entry({
      area: 'unstaged',
      path: 'resolved.ts',
      conflictStatus: 'resolved_locally'
    })
    const normal = entry({ area: 'unstaged', path: 'normal.ts' })
    const input = groups({ unstaged: [unresolved, resolved, normal] })

    const split = splitPinnedSourceControlConflicts(input)
    const sections = buildSourceControlDisplaySections(input, SOURCE_CONTROL_GROUP_ORDER)

    expect(split.pinnedConflicts.map((item) => item.path)).toEqual(['conflict.ts', 'resolved.ts'])
    expect(split.normalGroups.unstaged.map((item) => item.path)).toEqual(['normal.ts'])
    expect(sections.map((section) => section.id)).toEqual(['conflicts', 'unstaged'])
    expect(sections[0]?.items.map((item) => item.path)).toEqual(['conflict.ts', 'resolved.ts'])
    expect(sections[1]?.items.map((item) => item.path)).toEqual(['normal.ts'])
  })

  it('pins locally resolved staged conflicts and removes them from Staged Changes', () => {
    const resolvedStaged = entry({
      area: 'staged',
      path: 'resolved-staged.ts',
      conflictKind: 'both_modified',
      conflictStatus: 'resolved_locally'
    })
    const staged = entry({ area: 'staged', path: 'staged.ts' })
    const input = groups({ staged: [resolvedStaged, staged] })

    const split = splitPinnedSourceControlConflicts(input)
    const sections = buildSourceControlDisplaySections(input, SOURCE_CONTROL_GROUP_ORDER)

    expect(split.pinnedConflicts).toEqual([resolvedStaged])
    expect(split.normalGroups.staged).toEqual([staged])
    expect(sections.map((section) => section.id)).toEqual(['conflicts', 'staged'])
    expect(sections[0]?.items[0]?.area).toBe('staged')
    expect(sections[1]?.items).toEqual([staged])
  })

  it('builds review entries only for unresolved conflicts', () => {
    expect(
      getConflictReviewEntries([
        entry({
          area: 'unstaged',
          path: 'conflict.ts',
          conflictKind: 'both_modified',
          conflictStatus: 'unresolved'
        }),
        entry({
          area: 'unstaged',
          path: 'resolved.ts',
          conflictKind: 'both_modified',
          conflictStatus: 'resolved_locally'
        })
      ])
    ).toEqual([{ path: 'conflict.ts', conflictKind: 'both_modified' }])
  })

  it('routes the pinned Conflicts section to conflict review', () => {
    const sections = buildSourceControlDisplaySections(
      groups({
        unstaged: [
          entry({
            area: 'unstaged',
            path: 'conflict.ts',
            conflictKind: 'both_modified',
            conflictStatus: 'unresolved'
          }),
          entry({ area: 'unstaged', path: 'normal.ts' })
        ]
      }),
      SOURCE_CONTROL_GROUP_ORDER
    )

    expect(getSourceControlSectionViewAction(sections[0]!)).toEqual({
      kind: 'conflict-review',
      entries: [{ path: 'conflict.ts', conflictKind: 'both_modified' }]
    })
    expect(getSourceControlSectionViewAction(sections[1]!)).toEqual({
      kind: 'combined-diff',
      area: 'unstaged',
      entries: [entry({ area: 'unstaged', path: 'normal.ts' })]
    })
  })

  it('scopes normal combined-diff actions to the conflict-split section items', () => {
    const pinned = entry({
      area: 'unstaged',
      path: 'resolved.ts',
      conflictKind: 'both_modified',
      conflictStatus: 'resolved_locally'
    })
    const normal = entry({ area: 'unstaged', path: 'normal.ts' })
    const sections = buildSourceControlDisplaySections(
      groups({ unstaged: [pinned, normal] }),
      SOURCE_CONTROL_GROUP_ORDER
    )

    expect(getSourceControlSectionViewAction(sections[1]!)).toEqual({
      kind: 'combined-diff',
      area: 'unstaged',
      entries: [normal]
    })
  })

  it('routes locally resolved-only conflict sections to combined diff', () => {
    const resolved = entry({
      area: 'unstaged',
      path: 'resolved.ts',
      conflictKind: 'both_modified',
      conflictStatus: 'resolved_locally'
    })
    const sections = buildSourceControlDisplaySections(
      groups({
        unstaged: [resolved]
      }),
      SOURCE_CONTROL_GROUP_ORDER
    )

    expect(getSourceControlSectionViewAction(sections[0]!)).toEqual({
      kind: 'combined-diff',
      area: 'unstaged',
      entries: [resolved]
    })
  })

  it('uses a generic combined diff action for mixed-area resolved conflict sections', () => {
    const unstaged = entry({
      area: 'unstaged',
      path: 'resolved-unstaged.ts',
      conflictKind: 'both_modified',
      conflictStatus: 'resolved_locally'
    })
    const staged = entry({
      area: 'staged',
      path: 'resolved-staged.ts',
      conflictKind: 'both_modified',
      conflictStatus: 'resolved_locally'
    })
    const sections = buildSourceControlDisplaySections(
      groups({
        staged: [staged],
        unstaged: [unstaged]
      }),
      SOURCE_CONTROL_GROUP_ORDER
    )

    expect(getSourceControlSectionViewAction(sections[0]!)).toEqual({
      kind: 'combined-diff',
      entries: [unstaged, staged]
    })
  })
})
