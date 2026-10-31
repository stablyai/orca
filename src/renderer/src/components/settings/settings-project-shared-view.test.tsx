// @vitest-environment happy-dom
import { nestedRemovalCatalog } from './settings-project-continuity-test-fixtures'
import * as removalProduct from './repository/RepositoryRemoveProjectButton'
import * as unsavedRemoval from '../editor/removal-unsaved-editor-files'
import * as bufferViews from '@/store/slices/editor/buffers/editor-buffer-views'
import * as editorAutosave from '../editor/editor-autosave'
import { registerPendingEditorFlush } from '../editor/editor-pending-flush'
import { removeCurrentSettingsProject } from './use-settings-store-model'
import { makeWorktree, makeOpenFile } from '@/store/slices/store-test-helpers'
import { toast } from 'sonner'
import { useSettingsProjectRemovalDescription } from './repository/RepositoryRemoveProjectButton'
import { act, useLayoutEffect } from 'react'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it.each([100, 1000])(
  'bounds shared-record work through the real removal hook and fresh current action at V=%s',
  async (v) => {
    const { repos, x } = nestedRemovalCatalog()
    const worktrees = Array.from({ length: v }, (_, i) =>
      makeWorktree({
        id: `r::/srv/shared-workspace/${i}`,
        repoId: 'r',
        hostId: 'ssh:x',
        runtimeOwnerEnvironmentId: 'E'
      })
    )
    const outside = makeWorktree({
      id: 'q::/srv/outside',
      repoId: 'q',
      hostId: 'ssh:x',
      runtimeOwnerEnvironmentId: 'E'
    })
    const views = worktrees.map((worktree, i) =>
      makeOpenFile({
        id: `shared-${i}`,
        filePath: '/srv/shared.ts',
        worktreeId: worktree.id,
        runtimeEnvironmentId: 'E',
        isDirty: false
      })
    )
    const survivor = makeOpenFile({
      ...views[0],
      id: 'outside-survivor',
      worktreeId: outside.id
    })
    useAppStore.setState({
      worktreesByRepo: { r: worktrees, q: [outside] },
      openFiles: views,
      settings: { ...useAppStore.getState().settings!, editorAutoSave: false }
    })
    const record = useAppStore.getState().editorBufferIdOf[views[0].id]
    expect(new Set(views.map((file) => useAppStore.getState().editorBufferIdOf[file.id]))).toEqual(
      new Set([record])
    )
    expect(useAppStore.getState().editorBufferViews[record]).toEqual(views.map((file) => file.id))
    act(() => {
      useAppStore.getState().setEditorDraft(views[0].id, 'first common draft')
      useAppStore.getState().markFileDirty(views[0].id, true)
    })
    const sharedViews = useAppStore.getState().openFiles
    expect(
      views.every((file) => useAppStore.getState().editorDrafts[file.id] === 'first common draft')
    ).toBe(true)

    let inHelper = false
    const counts = {
      helper: 0,
      outer: 0,
      eligible: 0,
      records: 0,
      siblingLists: 0,
      inner: 0,
      outsideHelperSiblingReads: 0,
      flushes: 0
    }
    const rows: {
      phase: string
      helper: number
      outer: number
      eligible: number
      records: number
      siblingLists: number
      inner: number
      outsideHelperSiblingReads: number
      flushes: number
      commits: number
      outputs: string[][]
    }[] = []
    const outputs: string[][] = []
    const originalLastView = unsavedRemoval.lastViewUnsavedFiles
    const originalSiblings = bufferViews.editorBufferSiblingViewIds
    const originalRecord = bufferViews.editorBufferIdOfView
    const originalEligible = editorAutosave.canAutoSaveOpenFile
    const recordProbe = vi
      .spyOn(bufferViews, 'editorBufferIdOfView')
      .mockImplementation((...args) => {
        if (inHelper) {
          counts.records++
        }
        return originalRecord(...args)
      })
    const eligibilityProbe = vi
      .spyOn(editorAutosave, 'canAutoSaveOpenFile')
      .mockImplementation((file) => {
        if (inHelper) {
          counts.eligible++
        }
        return originalEligible(file)
      })
    const siblingProbe = vi
      .spyOn(bufferViews, 'editorBufferSiblingViewIds')
      .mockImplementation((...args) => {
        const actual = originalSiblings(...args)
        if (inHelper) {
          counts.siblingLists++
        }
        const observed = actual.slice()
        for (let i = 0; i < actual.length; i++) {
          Object.defineProperty(observed, i, {
            enumerable: true,
            configurable: true,
            get() {
              if (inHelper) {
                counts.inner++
              } else {
                counts.outsideHelperSiblingReads++
              }
              return actual[i]
            }
          })
        }
        return observed
      })
    const helperProbe = vi
      .spyOn(unsavedRemoval, 'lastViewUnsavedFiles')
      .mockImplementation((state, closed) => {
        counts.helper++
        const files = state.openFiles
        const iteratorDescriptor = Object.getOwnPropertyDescriptor(files, Symbol.iterator)
        const iterate = files[Symbol.iterator].bind(files)
        Object.defineProperty(files, Symbol.iterator, {
          configurable: true,
          value: function* () {
            for (const file of iterate()) {
              counts.outer++
              yield file
            }
          }
        })
        const previous = inHelper
        inHelper = true
        try {
          const result = originalLastView(state, closed)
          outputs.push(result.map((file) => file.id))
          return result
        } finally {
          inHelper = previous
          if (iteratorDescriptor) {
            Object.defineProperty(files, Symbol.iterator, iteratorDescriptor)
          } else {
            Reflect.deleteProperty(files, Symbol.iterator)
          }
        }
      })
    let commits = 0
    const reset = () => {
      Object.assign(counts, Object.fromEntries(Object.keys(counts).map((key) => [key, 0])))
      outputs.length = 0
    }
    const capture = (
      phase: string,
      beforeCommits: number,
      maxSiblings: number,
      expected: string[]
    ) => {
      const row = {
        phase,
        ...counts,
        commits: commits - beforeCommits,
        outputs: outputs.map((ids) => [...ids])
      }
      rows.push(row)
      process.stdout.write(`R shared phase ${JSON.stringify({ v, ...row })}\n`)
      expect(row.helper).toBeGreaterThan(0)
      expect(row.inner).toBeLessThanOrEqual(row.helper * maxSiblings)
      expect(row.siblingLists).toBe(row.helper)
      expect(row.outer).toBeGreaterThanOrEqual(v * row.helper)
      expect(row.eligible).toBeGreaterThanOrEqual(v * row.helper)
      expect(row.outputs).toEqual(Array.from({ length: row.helper }, () => expected))
      return row
    }
    const read = () =>
      removalProduct.prepareSettingsProjectRemoval(
        useAppStore.getState(),
        repos[0],
        'project',
        x.selectionKey,
        x.setups
      )
    const dispatch = vi.fn(async () => {})
    const originalRemove = useAppStore.getState().removeProject
    const toastProbe = vi.spyOn(toast, 'error')
    let unregister = () => {}
    let unmount = () => {}
    try {
      reset()
      const hook = renderHook(() => {
        const value = useSettingsProjectRemovalDescription(
          repos[0],
          'project',
          x.selectionKey,
          x.setups
        )
        useLayoutEffect(() => {
          commits++
        })
        return value
      })
      unmount = hook.unmount
      capture('initial-all-closing', 0, v, [views[0].id])
      const signature = hook.result.current.signature
      reset()
      const beforeDraft = commits
      act(() => useAppStore.getState().setEditorDraft(views[0].id, 'second common draft'))
      const draft = capture('separate-draft-before-equality', beforeDraft, v, [views[0].id])
      expect(draft.commits).toBe(0)
      expect(hook.result.current.signature).toBe(signature)
      expect(
        views.every(
          (file) => useAppStore.getState().editorDrafts[file.id] === 'second common draft'
        )
      ).toBe(true)
      expect(useAppStore.getState().openFiles.every((file) => file.isDirty)).toBe(true)
      reset()
      const beforeIrrelevant = commits
      act(() => useAppStore.setState({ activeRepoId: 'q' }))
      rows.push({
        phase: 'irrelevant-focus',
        ...counts,
        commits: commits - beforeIrrelevant,
        outputs: [...outputs]
      })
      expect(counts.helper).toBe(0)
      expect(commits).toBe(beforeIrrelevant)
      reset()
      read()
      capture('current-reader', commits, v, [views[0].id])

      for (const order of ['last', 'first'] as const) {
        const current = useAppStore.getState()
        const common = current.editorDrafts[views[0].id]
        if (common === undefined) {
          throw new Error('the actual shared record must retain its common draft')
        }
        const currentSurvivor = { ...current.openFiles[0], id: survivor.id, worktreeId: outside.id }
        if (order === 'first') {
          // Keep the actual survivor, then rejoin the closing views: the index retains join order.
          act(() => useAppStore.setState({ openFiles: [currentSurvivor] }))
        }
        reset()
        const before = commits
        act(() =>
          useAppStore.setState({
            openFiles:
              order === 'last'
                ? [...current.openFiles, currentSurvivor]
                : [currentSurvivor, ...sharedViews],
            editorDrafts: { ...useAppStore.getState().editorDrafts, [survivor.id]: common }
          })
        )
        expect(useAppStore.getState().editorBufferViews[record][order === 'last' ? v : 0]).toBe(
          survivor.id
        )
        expect(useAppStore.getState().editorBufferIdOf[survivor.id]).toBe(record)
        capture(`survivor-${order}`, before, order === 'last' ? v + 1 : 1, [])
        reset()
        const accepted = read()
        useAppStore.setState({ removeProject: dispatch })
        reset()
        await act(async () => {
          await removeCurrentSettingsProject(x.setups, accepted)
        })
        const acceptedRow = capture(
          `survivor-${order}-fresh-acceptance`,
          commits,
          order === 'last' ? v + 1 : 1,
          []
        )
        expect(acceptedRow.outsideHelperSiblingReads).toBeGreaterThan(0)
        expect(dispatch).toHaveBeenLastCalledWith('r', {
          hostId: 'runtime:E',
          errorFeedback: 'toast'
        })
      }
      reset()
      act(() => useAppStore.setState({ openFiles: sharedViews }))
      capture('survivor-removal-reentry', commits, v, [views[0].id])
      dispatch.mockClear()
      const accepted = read()
      reset()
      await act(async () => {
        await removeCurrentSettingsProject(x.setups, accepted)
      })
      capture('dirty-fresh-refusal', commits, v, [views[0].id])
      expect(dispatch).not.toHaveBeenCalled()
      expect(toastProbe).toHaveBeenCalledWith('Save or close 1 unsaved file in Harbor X first')

      // A clean accepted product must still observe edits delivered by the existing pending owner.
      act(() => {
        useAppStore.getState().clearEditorDrafts(views.map((file) => file.id))
        useAppStore.getState().markFileDirty(views[0].id, false)
      })
      const clean = read()
      unregister = registerPendingEditorFlush(views[0].id, () => {
        counts.flushes++
        useAppStore.getState().setEditorDraft(views[0].id, '')
      })
      reset()
      await act(async () => {
        await removeCurrentSettingsProject(x.setups, clean)
      })
      capture('pending-flush-fresh-refusal', commits, v, [views[0].id])
      expect(counts.flushes).toBe(1)
      expect(dispatch).not.toHaveBeenCalled()
      expect(useAppStore.getState().editorDrafts[views[0].id]).toBe('')
      unregister()
      unregister = () => {}
      act(() => useAppStore.getState().clearEditorDrafts(views.map((file) => file.id)))
      const saved = read()
      reset()
      await act(async () => {
        await removeCurrentSettingsProject(x.setups, saved)
      })
      // No eligible record remains: the helper still runs, but visits no sibling list.
      expect(counts.helper).toBeGreaterThan(0)
      expect(counts.inner).toBe(0)
      expect(outputs.every((ids) => ids.length === 0)).toBe(true)
      expect(dispatch).toHaveBeenCalledExactlyOnceWith('r', {
        hostId: 'runtime:E',
        errorFeedback: 'toast'
      })
      rows.push({
        phase: 'saved-reentry-continuation',
        ...counts,
        commits: 0,
        outputs: outputs.map((ids) => [...ids])
      })
      process.stdout.write(`R shared views ${JSON.stringify({ v, rows })}\n`)
    } finally {
      unregister()
      unmount()
      useAppStore.setState({ removeProject: originalRemove })
      helperProbe.mockRestore()
      siblingProbe.mockRestore()
      recordProbe.mockRestore()
      eligibilityProbe.mockRestore()
      toastProbe.mockRestore()
    }
  }
)
