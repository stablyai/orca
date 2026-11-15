// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { DiffSection } from '../../diff/sections/diff-section-types'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { useCombinedDiffSectionActions } from './use-combined-diff-section-actions'
import { getStoredTextDiffResult } from '../../diff/large-files/large-diff-section-content'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { acquireCombinedDiffSectionOperation } from '../load-sections/combined-diff-section-connection'

const mocks = vi.hoisted(() => ({ writeRuntimeFile: vi.fn() }))

vi.mock('@/runtime/files/mutations/runtime-file-mutation-client', () => ({
  writeRuntimeFile: mocks.writeRuntimeFile
}))
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    repos: [TEST_REPO],
    worktreesByRepo: {
      repo1: [makeWorktree({ id: 'wt-1', repoId: 'repo1', path: '/repo', hostId: 'local' })]
    },
    openFiles: [file]
  })
})

afterEach(() => {
  cleanup()
  mocks.writeRuntimeFile.mockReset()
})

const file: OpenFile = {
  id: 'combined',
  filePath: '/repo',
  relativePath: '',
  worktreeId: 'wt-1',
  language: 'plaintext',
  isDirty: false,
  mode: 'diff'
}

function section(): DiffSection {
  return {
    key: 'a.ts',
    path: 'a.ts',
    status: 'modified',
    originalContent: 'old',
    modifiedContent: 'section edit',
    collapsed: false,
    loading: false,
    dirty: true,
    diffResult: {
      kind: 'text',
      originalContent: 'old',
      modifiedContent: 'loaded',
      originalIsBinary: false,
      modifiedIsBinary: false
    },
    operation: acquireCombinedDiffSectionOperation(file, 'a.ts'),
    largeDiffRenderLimit: null
  }
}

const LIMITED: DiffSection['largeDiffRenderLimit'] = {
  limited: true,
  reason: 'character-count',
  lineCounts: null,
  characterCount: 7_000_000,
  limits: { maxLinesPerSide: 120_000, maxCombinedCharacters: 6_000_000 }
}

function renderSave(sections: DiffSection[], setSections = vi.fn()) {
  return renderHook(() =>
    useCombinedDiffSectionActions({
      activeGroupId: undefined,
      branchCompare: null,
      canOpenWorkspaceFileBrowserForPath: () => false,
      commitCompare: null,
      file,
      isAllMode: false,
      isBranchMode: false,
      isCommitMode: false,
      sections,
      sectionsRef: { current: sections },
      setSectionHeights: vi.fn(),
      setSections
    })
  ).result
}

it('refuses to guess a version for a load whose bodies were pruned', async () => {
  const loaded = section().diffResult
  const pruned: DiffSection = {
    ...section(),
    diffResult: loaded && getStoredTextDiffResult(loaded, LIMITED),
    largeDiffRenderLimit: LIMITED
  }
  const setSections = vi.fn()
  const result = renderSave([pruned], setSections)
  await act(() => result.current.handleSectionSaveRef.current(0))
  expect(mocks.writeRuntimeFile).not.toHaveBeenCalled()
  expect(setSections.mock.calls[0]?.[0]([pruned])).toEqual([{ ...pruned, saveConflict: true }])
})
