import { describe, expect, it } from 'vitest'
import type { GitBranchChangeEntry, GitStatusEntry } from '../../../../shared/types'
import {
  selectEditorPanelGitBranchEntries,
  selectEditorPanelGitStatusEntries
} from './editor-panel-git-entry-selector'

describe('editor panel Git entry selectors', () => {
  it('ignore background worktree writes across mounted editor panels', () => {
    const panelCount = 200
    const worktreeId = 'worktree-active'
    const statusEntries = [{ path: 'src/index.ts' }] as GitStatusEntry[]
    const branchEntries = [{ path: 'src/index.ts' }] as GitBranchChangeEntry[]
    let gitStatusByWorktree = { [worktreeId]: statusEntries }
    let gitBranchChangesByWorktree = { [worktreeId]: branchEntries }
    let wholeMapInvalidations = 0
    let scopedEntryInvalidations = 0

    for (let write = 0; write < 200; write += 1) {
      const previousStatusMap = gitStatusByWorktree
      gitStatusByWorktree = {
        ...gitStatusByWorktree,
        [`background-${write}`]: [{ path: `generated-${write}.ts` } as GitStatusEntry]
      }
      const previousBranchMap = gitBranchChangesByWorktree
      gitBranchChangesByWorktree = {
        ...gitBranchChangesByWorktree,
        [`background-${write}`]: [{ path: `generated-${write}.ts` } as GitBranchChangeEntry]
      }

      for (let panel = 0; panel < panelCount; panel += 1) {
        wholeMapInvalidations += Number(previousStatusMap !== gitStatusByWorktree)
        wholeMapInvalidations += Number(previousBranchMap !== gitBranchChangesByWorktree)
        scopedEntryInvalidations += Number(
          selectEditorPanelGitStatusEntries({ gitStatusByWorktree }, worktreeId) !== statusEntries
        )
        scopedEntryInvalidations += Number(
          selectEditorPanelGitBranchEntries({ gitBranchChangesByWorktree }, worktreeId) !==
            branchEntries
        )
      }
    }

    expect(wholeMapInvalidations).toBe(80_000)
    expect(scopedEntryInvalidations).toBe(0)
  })

  it('publishes owning entry replacements and handles an absent worktree', () => {
    const firstStatus = [{ path: 'src/old.ts' }] as GitStatusEntry[]
    const nextStatus = [{ path: 'src/new.ts' }] as GitStatusEntry[]
    const firstBranch = [{ path: 'src/old.ts' }] as GitBranchChangeEntry[]
    const nextBranch = [{ path: 'src/new.ts' }] as GitBranchChangeEntry[]

    expect(
      selectEditorPanelGitStatusEntries({ gitStatusByWorktree: { active: firstStatus } }, 'active')
    ).toBe(firstStatus)
    expect(
      selectEditorPanelGitStatusEntries({ gitStatusByWorktree: { active: nextStatus } }, 'active')
    ).toBe(nextStatus)
    expect(
      selectEditorPanelGitBranchEntries(
        { gitBranchChangesByWorktree: { active: firstBranch } },
        'active'
      )
    ).toBe(firstBranch)
    expect(
      selectEditorPanelGitBranchEntries(
        { gitBranchChangesByWorktree: { active: nextBranch } },
        'active'
      )
    ).toBe(nextBranch)
    expect(selectEditorPanelGitStatusEntries({ gitStatusByWorktree: {} }, null)).toBeUndefined()
  })
})
