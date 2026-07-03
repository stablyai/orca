import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../shared/types'
import {
  buildSourceControlDisplaySections,
  getConflictReviewEntries,
  getSourceControlSectionViewAction,
  resolveSourceControlGroupOrder,
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

describe('resolveSourceControlGroupOrder', () => {
  it('keeps Changes first by default', () => {
    expect(resolveSourceControlGroupOrder(undefined)).toEqual(['unstaged', 'staged', 'untracked'])
  })

  it('supports staged-first and untracked-first presets', () => {
    expect(resolveSourceControlGroupOrder('staged-first')).toEqual([
      'staged',
      'unstaged',
      'untracked'
    ])
    expect(resolveSourceControlGroupOrder('untracked-first')).toEqual([
      'untracked',
      'unstaged',
      'staged'
    ])
  })
})

describe('buildSourceControlDisplaySections', () => {
  it('uses the configured order for normal sections', () => {
    const sections = buildSourceControlDisplaySections(
      groups({
        staged: [entry({ area: 'staged', path: 'staged.ts' })],
        unstaged: [entry({ area: 'unstaged', path: 'changed.ts' })],
        untracked: [entry({ area: 'untracked', path: 'new.ts', status: 'untracked' })]
      }),
      resolveSourceControlGroupOrder('staged-first')
    )

    expect(sections.map((section) => section.id)).toEqual(['staged', 'unstaged', 'untracked'])
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
      resolveSourceControlGroupOrder('staged-first')
    )

    expect(sections.map((section) => section.id)).toEqual([
      'conflicts',
      'staged',
      'unstaged',
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
    const sections = buildSourceControlDisplaySections(
      input,
      resolveSourceControlGroupOrder('changes-first')
    )

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
    const sections = buildSourceControlDisplaySections(
      input,
      resolveSourceControlGroupOrder('staged-first')
    )

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
      resolveSourceControlGroupOrder('changes-first')
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
      resolveSourceControlGroupOrder('changes-first')
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
      resolveSourceControlGroupOrder('changes-first')
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
      resolveSourceControlGroupOrder('staged-first')
    )

    expect(getSourceControlSectionViewAction(sections[0]!)).toEqual({
      kind: 'combined-diff',
      entries: [unstaged, staged]
    })
  })
})
