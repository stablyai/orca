// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import type React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDiskBaselineSignature } from '../../../../../../shared/disk-baseline-signature'
import type { DiffSection } from '../../diff-section-types'
import type { OpenFile } from '@/store/slices/editor'
import { useCombinedDiffSectionActions } from './use-combined-diff-section-actions'
import { getStoredTextDiffResult } from '../../large-diff-section-content'
import { useAppStore } from '@/store'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { acquireCombinedDiffSectionOperation } from '../load-sections/combined-diff-section-connection'
import { fetchCombinedDiffSection } from '../load-sections/fetch-combined-diff-section'
import {
  makeFolderWorkspace,
  makeProjectGroup
} from '@/components/sidebar/folder-workspace-composer-submit-fixtures'

const mocks = vi.hoisted(() => ({ writeRuntimeFile: vi.fn(), diff: vi.fn() }))
vi.mock('@/runtime/runtime-git-diff-client', () => ({
  getRuntimeGitDiff: mocks.diff,
  getRuntimeGitBranchDiff: mocks.diff,
  getRuntimeGitCommitDiff: mocks.diff
}))

vi.mock('@/runtime/runtime-file-mutation-client', () => ({
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
  mocks.diff.mockReset()
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

it('guards section saves, marks a refusal as a section conflict, and overwrites only on request', async () => {
  const sections = [section()]
  const setSections = vi.fn()
  const { result } = renderHook(() =>
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
  )

  mocks.writeRuntimeFile.mockResolvedValueOnce({ ok: false, diskConflict: 'changed' })
  await act(() => result.current.handleSectionSaveRef.current(0))
  const guarded = { expectedSignature: getDiskBaselineSignature('loaded'), allowMissing: false }
  expect(mocks.writeRuntimeFile.mock.calls[0]?.[4]).toEqual(guarded)
  const [[markConflict]] = setSections.mock.calls
  expect(markConflict(sections)).toEqual([{ ...sections[0], saveConflict: true }])

  // Saving again stays guarded; only the conflict bar's Overwrite writes plain.
  mocks.writeRuntimeFile.mockResolvedValueOnce({ ok: false, diskConflict: 'changed' })
  await act(() => result.current.handleSectionSaveRef.current(0))
  expect(mocks.writeRuntimeFile.mock.calls[1]?.[4]).toEqual(guarded)

  mocks.writeRuntimeFile.mockResolvedValueOnce({ ok: true })
  await act(() => result.current.handleSectionSaveRef.current(0, 'overwrite'))
  expect(mocks.writeRuntimeFile.mock.calls[2]?.[4]).toBeUndefined()
})

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

// Why limited: a huge paste into an empty file trips the live render limit without pruning the load.
it('treats an empty loaded file as a known version, even after a huge paste', async () => {
  const empty: DiffSection = {
    ...section(),
    diffResult: {
      kind: 'text',
      originalContent: 'old',
      modifiedContent: '',
      originalIsBinary: false,
      modifiedIsBinary: false
    },
    largeDiffRenderLimit: LIMITED
  }
  const result = renderSave([empty])
  mocks.writeRuntimeFile.mockResolvedValueOnce({ ok: true })
  await act(() => result.current.handleSectionSaveRef.current(0))
  expect(mocks.writeRuntimeFile.mock.calls[0]?.[4]).toEqual({
    expectedSignature: getDiskBaselineSignature(''),
    allowMissing: false
  })
})

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

it('serializes overlapping saves of one section and never clobbers newer edits', async () => {
  let resolveFirst: (value: { ok: true }) => void = () => undefined
  let resolveSecond: (value: { ok: true }) => void = () => undefined
  mocks.writeRuntimeFile
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        })
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve
        })
    )
  const sectionsRef: { current: DiffSection[] } = {
    current: [{ ...section(), modifiedContent: 'first' }]
  }
  const setSections = vi.fn((update: React.SetStateAction<DiffSection[]>) => {
    sectionsRef.current = typeof update === 'function' ? update(sectionsRef.current) : update
  })
  const { result } = renderHook(() =>
    useCombinedDiffSectionActions({
      activeGroupId: undefined,
      branchCompare: null,
      canOpenWorkspaceFileBrowserForPath: () => false,
      commitCompare: null,
      file,
      isAllMode: false,
      isBranchMode: false,
      isCommitMode: false,
      sections: sectionsRef.current,
      sectionsRef,
      setSectionHeights: vi.fn(),
      setSections
    })
  )

  const first = result.current.handleSectionSaveRef.current(0)
  await act(async () => undefined)
  // The user keeps typing while the first write is in flight, then saves again.
  sectionsRef.current = [{ ...sectionsRef.current[0], modifiedContent: 'second' }]
  const second = result.current.handleSectionSaveRef.current(0)
  await act(async () => undefined)
  expect(mocks.writeRuntimeFile).toHaveBeenCalledTimes(1)

  resolveFirst({ ok: true })
  await act(() => first)
  // The older write moved only the baseline; the newer text stays unsaved.
  expect(sectionsRef.current[0]).toMatchObject({ modifiedContent: 'second', dirty: true })
  expect(mocks.writeRuntimeFile).toHaveBeenCalledTimes(2)

  resolveSecond({ ok: true })
  await act(() => second)
  expect(mocks.writeRuntimeFile.mock.calls[1]?.[2]).toBe('second')
  expect(mocks.writeRuntimeFile.mock.calls[1]?.[4]).toEqual({
    expectedSignature: getDiskBaselineSignature('first'),
    allowMissing: false
  })
  expect(sectionsRef.current[0]).toMatchObject({ modifiedContent: 'second', dirty: false })
})

it('applies a queued save to the section clicked even after rows are rebuilt', async () => {
  let resolveFirst: (value: { ok: true }) => void = () => undefined
  mocks.writeRuntimeFile
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        })
    )
    .mockResolvedValue({ ok: true })
  const clicked: DiffSection = {
    ...section(),
    key: 'b.ts',
    path: 'b.ts',
    modifiedContent: 'b edit'
  }
  const sectionsRef: { current: DiffSection[] } = {
    current: [{ ...section(), modifiedContent: 'a edit' }, clicked]
  }
  const { result } = renderHook(() =>
    useCombinedDiffSectionActions({
      activeGroupId: undefined,
      branchCompare: null,
      canOpenWorkspaceFileBrowserForPath: () => false,
      commitCompare: null,
      file,
      isAllMode: false,
      isBranchMode: false,
      isCommitMode: false,
      sections: sectionsRef.current,
      sectionsRef,
      setSectionHeights: vi.fn(),
      setSections: vi.fn()
    })
  )

  const first = result.current.handleSectionSaveRef.current(1)
  await act(async () => undefined)
  const overwrite = result.current.handleSectionSaveRef.current(1, 'overwrite')
  // The list is rebuilt while both wait: the clicked section moves to index 0.
  sectionsRef.current = [clicked, { ...section(), modifiedContent: 'a edit' }]
  resolveFirst({ ok: true })
  await act(() => Promise.all([first, overwrite]))

  const paths = mocks.writeRuntimeFile.mock.calls.map(([, path]) => path)
  expect(paths).toEqual(['/repo/b.ts', '/repo/b.ts'])
  expect(mocks.writeRuntimeFile.mock.calls[1]?.[4]).toBeUndefined()
})

it.each(['worktree', 'branch', 'commit'] as const)(
  'retains a mixed-folder canonical SSH read through %s diff Save and refuses a retarget',
  async (mode) => {
    const template = section()
    const combined = {
      ...file,
      worktreeId: 'folder:folder-workspace-1',
      filePath: '/repo/platform'
    }
    const local = {
      ...TEST_REPO,
      id: 'local',
      projectGroupId: 'group-1',
      path: '/repo/platform/web'
    }
    const ssh = {
      ...TEST_REPO,
      id: 'ssh',
      projectGroupId: 'group-1',
      path: '/repo/platform/api',
      executionHostId: 'ssh:box' as const
    }
    useAppStore.setState({
      openFiles: [combined],
      worktreesByRepo: {},
      folderWorkspaces: [makeFolderWorkspace({ folderPath: combined.filePath })],
      projectGroups: [makeProjectGroup()],
      repos: [local, ssh],
      sshConnectionStates: new Map(
        ['box', 'other'].map((targetId) => [
          targetId,
          {
            targetId,
            status: 'connected' as const,
            error: null,
            reconnectAttempt: 0,
            connectionGeneration: 7
          }
        ])
      )
    })
    mocks.diff.mockResolvedValue(template.diffResult)
    const loaded = await fetchCombinedDiffSection({
      file: combined,
      entry: { path: 'api/a.ts', status: 'modified', area: 'unstaged' },
      branchCompare: {
        baseRef: 'main',
        compareRef: 'branch',
        baseOid: 'a',
        headOid: 'b',
        mergeBase: 'c',
        compareVersion: '1'
      },
      commitCompare: {
        baseRef: 'main',
        compareRef: 'commit',
        commitOid: 'a',
        parentOid: 'b',
        compareVersion: '1'
      },
      isAllMode: false,
      isBranchMode: mode === 'branch',
      isCommitMode: mode === 'commit'
    })
    expect(mocks.diff.mock.calls[0][0]).toMatchObject({
      target: { kind: 'local' },
      connectionId: 'box',
      expectedExecutionHostId: 'ssh:box'
    })
    const sections = [
      {
        ...template,
        key: 'api/a.ts',
        path: 'api/a.ts',
        diffResult: loaded.result,
        operation: loaded.operation
      }
    ]
    const sectionsRef = { current: sections }
    const { result } = renderHook(() =>
      useCombinedDiffSectionActions({
        activeGroupId: undefined,
        branchCompare: null,
        commitCompare: null,
        canOpenWorkspaceFileBrowserForPath: () => false,
        file: combined,
        isAllMode: false,
        isBranchMode: false,
        isCommitMode: false,
        sections,
        sectionsRef,
        setSectionHeights: vi.fn(),
        setSections: vi.fn()
      })
    )
    mocks.writeRuntimeFile.mockResolvedValue({ ok: true })
    await act(() => result.current.handleSectionSaveRef.current(0))
    expect(mocks.writeRuntimeFile.mock.calls[0][0]).toMatchObject(mocks.diff.mock.calls[0][0])
    useAppStore.setState({ repos: [local, { ...ssh, executionHostId: 'ssh:other' }] })
    await act(() => result.current.handleSectionSaveRef.current(0))
    expect(mocks.writeRuntimeFile).toHaveBeenCalledOnce()
  }
)
