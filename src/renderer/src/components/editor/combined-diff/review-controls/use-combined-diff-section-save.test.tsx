// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { useCombinedDiffSectionsState } from '../use-combined-diff-sections-state'
import type { OpenFile } from '@/store/slices/editor'
import type { DiffSection } from '../../diff-section-types'
import { useCombinedDiffSectionSave } from './use-combined-diff-section-save'

const { writeFile, getContext } = vi.hoisted(() => ({
  writeFile: vi.fn(),
  getContext: vi.fn(() => ({ connectionId: 'remote-connection' }))
}))
vi.mock('@/runtime/runtime-file-client', () => ({ writeRuntimeFile: writeFile }))
vi.mock('@/lib/editor-file-operation-owner', () => ({ getEditorFileOperationContext: getContext }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ worktreesByRepo: {} }) } }))

const file = {
  id: 'combined',
  filePath: '/repo',
  worktreeId: 'folder-workspace',
  runtimeEnvironmentId: 'remote-environment',
  operationProvenance: { owner: 'remote' }
} as unknown as OpenFile
function section(key = 'file.ts'): DiffSection {
  return {
    key,
    path: key,
    status: 'modified',
    area: 'unstaged',
    originalContent: 'original',
    modifiedContent: 'first draft',
    dirty: true,
    collapsed: false,
    loading: false,
    largeDiffRenderLimit: null,
    contentGeneration: 1,
    diffResult: {
      kind: 'text',
      originalContent: 'original',
      modifiedContent: 'disk',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
  }
}
const reloadSpy = vi.fn()
function setup(initial = [section()]) {
  return renderHook(() => {
    const { sections, setSections, sectionsRef } = useCombinedDiffSectionsState(initial)
    const [heights, setSectionHeights] = useState<Record<number, number>>({ 0: 100, 1: 200 })
    const save = useCombinedDiffSectionSave({
      file,
      requestSectionReloadRef: { current: reloadSpy },
      sectionsRef,
      setSections,
      setSectionHeights
    })
    return { sections, setSections, heights, save }
  })
}
function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('combined diff section saves', () => {
  it('saves native editor edits before React commits a render', async () => {
    writeFile.mockResolvedValue(undefined)
    const view = setup([{ ...section(), dirty: false, modifiedContent: 'disk' }])
    await act(async () => {
      view.result.current.setSections((prev) => [
        { ...prev[0], modifiedContent: 'typed immediately before save', dirty: true }
      ])
      await view.result.current.save.current(0)
    })
    expect(writeFile.mock.calls[0]?.[2]).toBe('typed immediately before save')
    expect(view.result.current.sections[0].dirty).toBe(false)
  })

  it('keeps edits made during a delayed remote write and advances only the saved baseline', async () => {
    const pending = deferred()
    writeFile.mockReturnValueOnce(pending.promise)
    const view = setup()
    let save!: Promise<void>
    await act(async () => {
      save = view.result.current.save.current(0)
    })
    act(() =>
      view.result.current.setSections((prev) => [{ ...prev[0], modifiedContent: 'newer draft' }])
    )
    await act(async () => {
      pending.resolve()
      await save
    })
    expect(view.result.current.sections[0]).toMatchObject({
      modifiedContent: 'newer draft',
      dirty: true,
      diffResult: { modifiedContent: 'first draft' }
    })
    expect(getContext).toHaveBeenCalledWith(expect.anything(), file, null)
    expect(writeFile).toHaveBeenCalledWith(
      { connectionId: 'remote-connection' },
      '/repo/file.ts',
      'first draft'
    )
  })

  it('serializes saves, reading the latest draft when a queued write starts', async () => {
    const first = deferred()
    const second = deferred()
    writeFile.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const view = setup()
    let save1!: Promise<void>
    let save2!: Promise<void>
    await act(async () => {
      save1 = view.result.current.save.current(0)
    })
    act(() =>
      view.result.current.setSections((prev) => [{ ...prev[0], modifiedContent: 'second draft' }])
    )
    await act(async () => {
      save2 = view.result.current.save.current(0)
    })
    expect(writeFile).toHaveBeenCalledTimes(1)
    act(() =>
      view.result.current.setSections((prev) => [{ ...prev[0], modifiedContent: 'latest draft' }])
    )
    await act(async () => {
      first.resolve()
      await save1
    })
    expect(writeFile).toHaveBeenCalledTimes(2)
    expect(writeFile.mock.calls[1][2]).toBe('latest draft')
    await act(async () => {
      second.resolve()
      await save2
    })
    expect(view.result.current.sections[0]).toMatchObject({
      modifiedContent: 'latest draft',
      dirty: false
    })
  })

  it('acknowledges the right file after reordering sections', async () => {
    const pending = deferred()
    writeFile.mockReturnValueOnce(pending.promise)
    const other = section('other.ts')
    const view = setup([section(), other])
    let save!: Promise<void>
    await act(async () => {
      save = view.result.current.save.current(0)
    })
    act(() => view.result.current.setSections((prev) => [prev[1], prev[0]]))
    await act(async () => {
      pending.resolve()
      await save
    })
    expect(view.result.current.sections[0]).toBe(other)
    expect(view.result.current.sections[1].dirty).toBe(false)
    expect(view.result.current.heights).toEqual({ 0: 100 })
  })

  it('leaves a replacement generation alone and cancels its stale queued write', async () => {
    const pending = deferred()
    writeFile.mockReturnValueOnce(pending.promise)
    const view = setup()
    let save1!: Promise<void>
    let save2!: Promise<void>
    await act(async () => {
      save1 = view.result.current.save.current(0)
      save2 = view.result.current.save.current(0)
    })
    const replacement = {
      ...section(),
      modifiedContent: 'reloaded',
      contentGeneration: 2,
      dirty: false
    }
    act(() => view.result.current.setSections([replacement]))
    await act(async () => {
      pending.resolve()
      await Promise.all([save1, save2])
    })
    expect(view.result.current.sections[0]).toBe(replacement)
    expect(writeFile).toHaveBeenCalledTimes(1)
  })

  it('retains the draft and baseline after write failure and permits retry', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFile.mockRejectedValueOnce(new Error('disconnected')).mockResolvedValueOnce(undefined)
    const initial = section()
    const view = setup([initial])
    await act(async () => {
      await view.result.current.save.current(0)
    })
    expect(view.result.current.sections[0]).toBe(initial)
    await act(async () => {
      await view.result.current.save.current(0)
    })
    expect(view.result.current.sections[0].dirty).toBe(false)
    error.mockRestore()
  })

  it('never writes staged or branch content', async () => {
    const view = setup([
      { ...section(), area: 'staged' },
      { ...section('branch'), area: undefined }
    ])
    await act(async () => {
      await view.result.current.save.current(0)
      await view.result.current.save.current(1)
    })
    expect(writeFile).not.toHaveBeenCalled()
  })
})

it('re-drives a reload after saving, so a revalidation rejected while dirty is not stranded', async () => {
  const { result } = setup()
  await act(async () => {
    await result.current.save.current(0)
  })
  // The git-status signature does not change for an edit inside an already-modified line, so the
  // save is the only event that can recover a stale original side.
  expect(reloadSpy).toHaveBeenCalledWith(0)
})
