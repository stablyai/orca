// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { DiffSection } from '../../diff-section-types'
import { useCombinedDiffSectionLoadRegistry } from '../load-sections/combined-diff-section-load-registry'
import type { CombinedDiffEntrySet } from '../resolve-changes/use-combined-diff-entry-set'
import { combinedDiffViewStateCache } from './combined-diff-view-memory'
import { useCombinedDiffViewRestore } from './use-combined-diff-view-restore'
import { disposeClosedEditorTabs } from '../../closed-editor-tab-disposal'
import type { MonacoModelRegistry } from '../../diff-monaco-model-disposal'
import type { OpenFile } from '@/store/slices/editor'

function buildAllModeEntrySet(
  uncommittedEntries: GitStatusEntry[],
  renderableBranchEntries: GitBranchChangeEntry[]
): CombinedDiffEntrySet {
  const entries = [...uncommittedEntries, ...renderableBranchEntries]
  return {
    allEntries: entries,
    branchCompare: null,
    commitCompare: null,
    commitEntries: [],
    entries,
    entrySignature: JSON.stringify(entries),
    hasUncommittedEntriesSnapshot: false,
    isAllMode: true,
    isBranchMode: false,
    isCommitMode: false,
    renderableBranchEntries,
    shouldAutoReloadFromGitStatus: false,
    treeMode: 'all',
    uncommittedEntries
  }
}

function restoreSections(entrySet: CombinedDiffEntrySet, viewStateKey: string): DiffSection[] {
  let sections: DiffSection[] = []
  renderHook(() => {
    const registry = useCombinedDiffSectionLoadRegistry([])
    return useCombinedDiffViewRestore({
      entrySet,
      gitStatusEntries: [],
      registry,
      setGeneration: () => {},
      setSectionHeights: () => {},
      setSections: (value) => {
        sections = typeof value === 'function' ? value(sections) : value
      },
      setSideBySide: () => {},
      viewStateKey
    })
  })
  return sections
}

describe('useCombinedDiffViewRestore deferral', () => {
  afterEach(() => {
    cleanup()
    combinedDiffViewStateCache.clear()
  })

  it('keeps uncommitted rows deferred when only the branch pass counted', () => {
    // combined-all concatenates two independent passes: the uncommitted numstat
    // can fail (or be skipped at the entry cap) while the compare diff succeeds.
    const sections = restoreSections(
      buildAllModeEntrySet(
        [
          { path: 'src/app.ts', status: 'modified', area: 'unstaged' },
          { path: 'src/store.ts', status: 'modified', area: 'unstaged' }
        ],
        [{ path: 'src/branch.ts', status: 'modified', added: 12, removed: 3 }]
      ),
      'mixed-pass-view'
    )
    expect(sections.map((section) => section.loadOnDemand)).toEqual([true, true, false])
  })

  it('restores a closed combined-diff tab from the view-state cache when it is reopened', () => {
    // Why this test exists: combined-diff tab ids are deterministic
    // (`<worktreeId>::all-diffs::uncommitted`), so closing and reopening the review hits the same
    // viewStateKey and restores loaded bodies + scroll with no refetch. Sweeping the combined-diff
    // view-state caches on tab close would therefore change what the user sees on reopen.
    const entrySet = buildAllModeEntrySet(
      [{ path: 'src/app.ts', status: 'modified', area: 'unstaged', added: 5 }],
      []
    )
    const viewStateKey = 'wt-1::all-diffs::uncommitted'
    const loadedSections: DiffSection[] = [
      {
        key: 'unstaged:src/app.ts',
        path: 'src/app.ts',
        status: 'modified',
        area: 'unstaged',
        added: 5,
        originalContent: 'before',
        modifiedContent: 'after',
        collapsed: false,
        loading: false,
        dirty: false,
        diffResult: null,
        largeDiffRenderLimit: null
      }
    ]
    combinedDiffViewStateCache.set(viewStateKey, {
      entrySignature: entrySet.entrySignature,
      gitStatusSignature: '',
      sections: loadedSections,
      sectionHeights: {},
      loadedIndices: [0],
      scrollTop: 0,
      sideBySide: false
    })
    cleanup()

    const closedTab = {
      id: viewStateKey,
      mode: 'diff',
      diffSource: 'combined-uncommitted',
      filePath: '/repo',
      worktreeId: 'wt-1'
    } as unknown as OpenFile
    disposeClosedEditorTabs(
      {
        editor: { getModel: () => null, getModels: () => [] },
        Uri: { parse: (v: string) => v }
      } as unknown as MonacoModelRegistry,
      [closedTab]
    )

    expect(restoreSections(entrySet, viewStateKey)).toEqual(loadedSections)
  })

  it('auto-loads an uncounted tracked row once its own pass counted something', () => {
    const sections = restoreSections(
      buildAllModeEntrySet(
        [
          { path: 'resources/build/icon.icns', status: 'modified', area: 'unstaged' },
          { path: 'src/app.ts', status: 'modified', area: 'unstaged', added: 5 }
        ],
        []
      ),
      'counted-pass-view'
    )
    expect(sections.map((section) => section.loadOnDemand)).toEqual([false, false])
  })
})
