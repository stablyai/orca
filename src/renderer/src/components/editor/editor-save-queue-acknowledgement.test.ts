import { setImmediate as nextTurn } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { createEditorStore, stubEditorWindow } from './editor-autosave-controller-test-fixture'
import {
  ORCA_EDITOR_FILE_SAVED_EVENT,
  ORCA_EDITOR_SAVE_AND_CLOSE_EVENT,
  requestEditorFileSave,
  requestEditorSaveQuiesce
} from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { createEditorSaveQueue } from './editor-save-queue'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))

function setup() {
  const write = stubEditorWindow()
  const store = createEditorStore()
  const settings = store.getState().settings
  if (!settings) {
    throw new Error('Missing test settings')
  }
  store.setState({ settings: { ...settings, editorAutoSave: false } })
  const id = store.getState().openFile({
    filePath: '/repo/file.txt',
    relativePath: 'file.txt',
    worktreeId: 'wt-1',
    mode: 'edit',
    language: 'text'
  })
  const file = store.getState().openFiles.find((candidate) => candidate.id === id)
  if (!file) {
    throw new Error('Missing test file')
  }
  const blocked = Promise.withResolvers<void>()
  write.mockReturnValueOnce(blocked.promise)
  const queue = createEditorSaveQueue(store)
  const saved: string[] = []
  window.addEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, (event) => {
    if (event instanceof CustomEvent) {
      saved.push(event.detail.content)
    }
  })
  return { write, store, file, queue, saved, blocked }
}

afterEach(() => {
  __clearSelfWriteRegistryForTests()
  vi.unstubAllGlobals()
})

it('rejects a replaced fallback-only user intent instead of reporting a dropped write as saved', async () => {
  const { write, file, queue, saved, blocked } = setup()
  const first = queue.queueSave(file, 'first')
  await nextTurn()
  const older = queue.queueSave(file, 'older').then(
    () => 'saved',
    (error) => error.message
  )
  const latest = queue.queueSave(file, 'latest')
  blocked.resolve()
  await Promise.all([first, latest])
  expect(await older).toMatch(/superseded/i)
  expect(write.mock.calls.map(([args]) => args.content)).toEqual(['first', 'latest'])
  expect(saved).toEqual(['first', 'latest'])
  queue.dispose()
})

it('joins identical fallback-only requests without rejecting a content that reaches disk', async () => {
  const { write, file, queue, blocked } = setup()
  const first = queue.queueSave(file, 'first')
  await nextTurn()
  const older = queue.queueSave(file, 'same')
  const latest = queue.queueSave(file, 'same')
  blocked.resolve()
  await Promise.all([first, older, latest])
  expect(write.mock.calls.map(([args]) => args.content)).toEqual(['first', 'same'])
  queue.dispose()
})

it('keeps the existing current-document contract for draft-backed requests', async () => {
  const { write, store, file, queue, blocked } = setup()
  const first = queue.queueSave(file, 'first')
  await nextTurn()
  store.getState().setEditorDraft(file.id, 'older')
  const older = queue.queueSave(file, 'older')
  store.getState().setEditorDraft(file.id, 'latest')
  const latest = queue.queueSave(file, 'latest')
  blocked.resolve()
  await Promise.all([first, older, latest])
  expect(write.mock.calls.map(([args]) => args.content)).toEqual(['first', 'latest'])
  queue.dispose()
})

it('rejects an invalidated pending manual save while quiescence preserves the latest draft', async () => {
  const { write, store, file, queue, saved, blocked } = setup()
  const first = queue.queueSave(file, 'first')
  await nextTurn()
  store.getState().setEditorDraft(file.id, 'unsaved latest')
  const pending = queue.queueSave(file, 'unsaved latest').then(
    () => 'saved',
    (error) => error.message
  )
  const drained = queue.quiesceFileSave(file.id)
  blocked.resolve()
  await Promise.all([first, drained])
  expect(await pending).toMatch(/cancelled/i)
  expect(write).toHaveBeenCalledTimes(1)
  expect(saved).toEqual([])
  expect(store.getState().editorDrafts[file.id]).toBe('unsaved latest')
  queue.dispose()
})

it('drops a pending save on controller disposal instead of starting it afterward', async () => {
  const { write, file, queue, saved, blocked } = setup()
  const first = queue.queueSave(file, 'first')
  await nextTurn()
  const pending = queue.queueSave(file, 'pending').catch((error) => error.message)
  queue.dispose()
  blocked.resolve()
  await expect(first).resolves.toBeUndefined()
  expect(await pending).toMatch(/cancelled/i)
  expect(write).toHaveBeenCalledTimes(1)
  expect(saved).toEqual([])
})

it('does not close a tab when its pending save-close request is cancelled', async () => {
  const { write, store, file, queue, saved, blocked } = setup()
  queue.dispose()
  const detach = attachEditorAutosaveController(store)
  store.getState().setEditorDraft(file.id, 'first')
  store.getState().markFileDirty(file.id, true)
  const first = requestEditorFileSave({ fileId: file.id })
  await nextTurn()
  store.getState().setEditorDraft(file.id, 'unsaved latest')
  window.dispatchEvent(
    new CustomEvent(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, { detail: { fileId: file.id } })
  )
  const drained = requestEditorSaveQuiesce({ fileId: file.id })
  blocked.resolve()
  await Promise.all([first, drained])
  await nextTurn()
  expect(store.getState().openFiles.some((candidate) => candidate.id === file.id)).toBe(true)
  expect(store.getState().editorDrafts[file.id]).toBe('unsaved latest')
  expect(store.getState().openFiles.find((candidate) => candidate.id === file.id)?.isDirty).toBe(
    true
  )
  expect(write).toHaveBeenCalledTimes(1)
  expect(saved).toEqual([])
  detach()
})

it('surfaces the latest write failure, preserves its draft, and permits a successful retry', async () => {
  const { write, store, file, queue, saved, blocked } = setup()
  queue.dispose()
  const detach = attachEditorAutosaveController(store)
  store.getState().setEditorDraft(file.id, 'first')
  store.getState().markFileDirty(file.id, true)
  const first = requestEditorFileSave({ fileId: file.id })
  await nextTurn()
  store.getState().setEditorDraft(file.id, 'older')
  const older = requestEditorFileSave({ fileId: file.id }).catch((error: Error) => error.message)
  store.getState().setEditorDraft(file.id, 'retry latest')
  const latest = requestEditorFileSave({ fileId: file.id }).catch((error: Error) => error.message)
  write.mockRejectedValueOnce(new Error('disk full'))
  blocked.resolve()
  await first
  expect(await Promise.all([older, latest])).toEqual(['disk full', 'disk full'])
  expect(store.getState().editorDrafts[file.id]).toBe('retry latest')
  expect(store.getState().openFiles.find((candidate) => candidate.id === file.id)?.isDirty).toBe(
    true
  )
  expect(saved).toEqual(['first'])
  await requestEditorFileSave({ fileId: file.id })
  expect(saved).toEqual(['first', 'retry latest'])
  expect(store.getState().editorDrafts[file.id]).toBeUndefined()
  expect(store.getState().openFiles.find((candidate) => candidate.id === file.id)?.isDirty).toBe(
    false
  )
  detach()
})

it('lets an already dispatched write finish after disposal without publishing stale metadata', async () => {
  const { write, store, file, queue, saved, blocked } = setup()
  store.getState().setEditorDraft(file.id, 'first')
  store.getState().markFileDirty(file.id, true)
  const first = queue.queueSave(file, 'first')
  await nextTurn()
  queue.dispose()
  blocked.resolve()
  await expect(first).resolves.toBeUndefined()
  expect(write).toHaveBeenCalledTimes(1)
  expect(saved).toEqual([])
  expect(store.getState().editorDrafts[file.id]).toBe('first')
  expect(store.getState().openFiles.find((candidate) => candidate.id === file.id)?.isDirty).toBe(
    true
  )
})

it('rejects earlier fallback snapshots after replacements even when the newest text returns to the same value', async () => {
  const { write, file, queue, blocked } = setup()
  const first = queue.queueSave(file, 'first')
  await nextTurn()
  const older = queue.queueSave(file, 'same').catch((error: Error) => error.message)
  const middle = queue.queueSave(file, 'different').catch((error: Error) => error.message)
  const latest = queue.queueSave(file, 'same')
  blocked.resolve()
  await Promise.all([first, latest])
  expect(await older).toContain('superseded')
  expect(await middle).toContain('superseded')
  expect(write.mock.calls.map(([args]) => args.content)).toEqual(['first', 'same'])
  queue.dispose()
})
