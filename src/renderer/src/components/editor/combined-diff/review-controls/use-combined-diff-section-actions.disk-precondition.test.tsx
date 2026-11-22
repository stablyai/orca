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
import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'

const mocks = vi.hoisted(() => ({ writeRuntimeFile: vi.fn(), confirm: vi.fn() }))

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
  mocks.confirm.mockReset()
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

function section(loaded = 'loaded'): DiffSection {
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
      modifiedContent: loaded,
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
  return renderHook(
    () =>
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
      }),
    {
      wrapper: ({ children }) => (
        <ConfirmationDialogContext.Provider value={mocks.confirm}>
          {children}
        </ConfirmationDialogContext.Provider>
      )
    }
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

it.each([
  ['sends no UTF-8 check for text that decoded losslessly', 'loaded', undefined],
  ['asks the host to check bytes behind a U+FFFD', 'caf\uFFFD', true]
])('%s', async (_label, loaded, requireLosslessUtf8) => {
  mocks.writeRuntimeFile.mockResolvedValueOnce({ ok: true })
  const result = renderSave([section(loaded)])

  await act(() => result.current.handleSectionSaveRef.current(0))
  expect(mocks.writeRuntimeFile.mock.calls[0]?.[4]).toEqual({
    expectedSignature: expect.any(String),
    allowMissing: false,
    ...(requireLosslessUtf8 ? { requireLosslessUtf8 } : {})
  })
})

it.each([
  ['converts once the user confirms', true, 2],
  ['writes nothing when the user declines', false, 1]
])('on a non-UTF-8 refusal %s', async (_label, accepted, writes) => {
  mocks.writeRuntimeFile.mockResolvedValueOnce({ ok: false, diskConflict: 'not-utf8' })
  mocks.writeRuntimeFile.mockResolvedValueOnce({ ok: true })
  mocks.confirm.mockResolvedValueOnce(accepted)
  const setSections = vi.fn()
  const result = renderSave([section('caf\uFFFD')], setSections)

  await act(() => result.current.handleSectionSaveRef.current(0))
  expect(mocks.confirm).toHaveBeenCalledOnce()
  expect(mocks.confirm).toHaveBeenCalledWith(
    expect.objectContaining({ confirmVariant: 'destructive' })
  )
  expect(mocks.writeRuntimeFile).toHaveBeenCalledTimes(writes)
  if (accepted) {
    expect(mocks.writeRuntimeFile.mock.calls[1]?.[4]).toEqual({
      expectedSignature: expect.any(String),
      allowMissing: false
    })
  } else {
    expect(setSections).not.toHaveBeenCalled()
  }
})
