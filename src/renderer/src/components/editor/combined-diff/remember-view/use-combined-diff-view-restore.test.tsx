// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { DiffSection } from '../../diff-section-types'
import { useCombinedDiffSectionLoadRegistry } from '../load-sections/combined-diff-section-load-registry'
import type { CombinedDiffEntrySet } from '../resolve-changes/use-combined-diff-entry-set'
import {
  claimCombinedDiffView,
  clearCombinedDiffViewMemory,
  readCombinedDiffViewMemory,
  releaseCombinedDiffView,
  rememberCombinedDiffView,
  type CombinedDiffViewSuccession
} from './combined-diff-view-cache'
import { useCombinedDiffViewRestore } from './use-combined-diff-view-restore'
import { createStore } from 'zustand/vanilla'
import { createEditorModelRegistry } from '@/lib/editor-model-registry'
import { attachClosedEditorTabCleanup } from '../../closed-editor-tab-controller'
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

function restoreSections(
  entrySet: CombinedDiffEntrySet,
  viewStateKey: string,
  succession?: CombinedDiffViewSuccession
): DiffSection[] {
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
      succession,
      viewStateKey,
      worktreeId: 'wt-1'
    })
  })
  return sections
}

describe('useCombinedDiffViewRestore deferral', () => {
  afterEach(() => {
    cleanup()
    clearCombinedDiffViewMemory()
  })

  it('keeps uncommitted rows deferred when only the branch pass counted', () => {
    // All mode combines independent passes; successful compare counts cannot prove the uncommitted pass ran.
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

  it('restores a closed combined-diff tab with a cold model registry when reopened', async () => {
    // Closing must preserve loaded bodies and scroll for reopening, even after the model registry is cleared.
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
    const lease = claimCombinedDiffView(viewStateKey, 'wt-1')
    rememberCombinedDiffView(lease, {
      view: {
        entrySignature: entrySet.entrySignature,
        gitStatusSignature: '',
        sections: loadedSections,
        sectionHeights: {},
        loadedIndices: [0],
        sideBySide: false
      }
    })
    releaseCombinedDiffView(lease)
    cleanup()

    const closedTab: OpenFile = {
      id: viewStateKey,
      mode: 'diff',
      diffSource: 'combined-uncommitted',
      filePath: '/repo',
      worktreeId: 'wt-1',
      relativePath: '',
      language: 'plaintext',
      isDirty: false
    }
    const store = createStore(() => ({ openFiles: [closedTab] }))
    const detach = attachClosedEditorTabCleanup(store, createEditorModelRegistry())
    try {
      store.setState({ openFiles: [] })
      await Promise.resolve()
      store.setState({ openFiles: [closedTab] })
      expect(restoreSections(entrySet, viewStateKey)).toEqual(loadedSections)
    } finally {
      detach()
    }
  })

  it('restores a closed tab-scoped review in the fresh tab that reopens it', () => {
    const entrySet = buildAllModeEntrySet(
      [{ path: 'src/app.ts', status: 'modified', area: 'unstaged', added: 5 }],
      []
    )
    const contentKey = 'wt-1::all-diffs::uncommitted'
    const tabSuccession = (scopeId: string): CombinedDiffViewSuccession => ({
      contentKey,
      scopeId,
      isScopeOpen: (id) => id === 'tab-reopened'
    })
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
    const lease = claimCombinedDiffView(
      `${contentKey}::tab-closed`,
      'wt-1',
      tabSuccession('tab-closed')
    )
    rememberCombinedDiffView(lease, {
      scrollTop: 900,
      view: {
        entrySignature: entrySet.entrySignature,
        gitStatusSignature: '',
        sections: loadedSections,
        sectionHeights: {},
        loadedIndices: [0],
        sideBySide: false
      }
    })
    releaseCombinedDiffView(lease)

    const reopenedKey = `${contentKey}::tab-reopened`
    expect(restoreSections(entrySet, reopenedKey, tabSuccession('tab-reopened'))).toEqual(
      loadedSections
    )
    expect(readCombinedDiffViewMemory(reopenedKey)?.scrollTop).toBe(900)
    expect(readCombinedDiffViewMemory(`${contentKey}::tab-closed`)).toBeUndefined()
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
