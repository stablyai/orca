import { expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import type { AppState } from '@/store'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import * as dueRecords from './editor-autosave-due-records'

export function registerEditorAutosaveAcquisitionBudgetTests(
  createFixture: () => {
    store: StoreApi<AppState>
    disk: { files: Map<string, string>; fs: { writeFile: ReturnType<typeof vi.fn> } }
    stampBaselines(): void
  }
): void {
  it.each([5, 50])(
    'bounds first-acquisition autosave scans for %i restored drafts',
    async (count) => {
      const { disk, store, stampBaselines } = createFixture()
      for (let index = 0; index < count; index += 1) {
        const filePath = `/repo/file-${index}.ts`
        disk.files.set(filePath, '')
        store.getState().openFile({
          filePath,
          relativePath: `file-${index}.ts`,
          worktreeId: 'wt-1',
          language: 'typescript',
          mode: 'edit'
        })
        store.getState().setEditorDraft(filePath, `draft-${index}`)
        store.getState().markFileDirty(filePath, true)
      }
      stampBaselines()
      store.setState({
        openFiles: store.getState().openFiles.map((file) => ({
          ...file,
          operationProvenance: undefined
        }))
      })
      const unsubscribe = store.subscribe((state, previous) => {
        if (
          state.openFiles[0]?.operationProvenance &&
          !previous.openFiles[0]?.operationProvenance
        ) {
          state.setEditorDraft('/repo/file-0.ts', 'newer draft')
        }
      })
      const scans = vi.spyOn(dueRecords, 'editorAutoSaveDueRecords')
      const cleanup = attachEditorAutosaveController(store)
      try {
        expect(store.getState().openFiles.every((file) => file.operationProvenance)).toBe(true)
        expect(scans.mock.calls.length).toBeLessThanOrEqual(4)
        expect(vi.getTimerCount()).toBe(count)
        await vi.advanceTimersByTimeAsync(999)
        for (const file of store.getState().openFiles) {
          store.getState().acquireEditorFileOperationProvenance(file)
        }
        expect(disk.fs.writeFile).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(count)
        await vi.advanceTimersByTimeAsync(1)
        expect(disk.fs.writeFile).toHaveBeenCalledTimes(count)
        expect(store.getState().openFiles.every((file) => !file.isDirty)).toBe(true)
        expect(store.getState().editorDrafts).toEqual({})
        await vi.advanceTimersByTimeAsync(1000)
        expect(disk.fs.writeFile).toHaveBeenCalledTimes(count)
        expect(vi.getTimerCount()).toBe(0)
        for (let index = 0; index < count; index += 1) {
          expect(disk.files.get(`/repo/file-${index}.ts`)).toBe(
            index === 0 ? 'newer draft' : `draft-${index}`
          )
        }
      } finally {
        cleanup()
        unsubscribe()
        scans.mockRestore()
      }
    }
  )
}
