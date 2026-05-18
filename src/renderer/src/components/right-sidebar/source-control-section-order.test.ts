import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../shared/types'
import {
  buildSourceControlDisplaySections,
  getConflictReviewEntries,
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
})
