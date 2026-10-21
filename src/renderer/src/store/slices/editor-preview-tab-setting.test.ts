import type { StoreApi } from 'zustand/vanilla'
import { describe, expect, it, vi } from 'vitest'
import { createEditorTabsStore } from './editor-slice-test-harness'
import type { AppState } from '../types'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { getReplaceablePreviewFileId } from './editor/tabs/workspace-editor-item'

const { toastErrorMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: toastErrorMock }
}))

const { notifyHostOfMirroredEditorCloseMock } = vi.hoisted(() => ({
  notifyHostOfMirroredEditorCloseMock: vi.fn()
}))
vi.mock('@/runtime/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: (...args: unknown[]) =>
    notifyHostOfMirroredEditorCloseMock(...args)
}))

function openPreview(store: StoreApi<AppState>, relativePath: string): void {
  store.getState().openFile(
    {
      filePath: `/repo/${relativePath}`,
      relativePath,
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    },
    { preview: true }
  )
}

function storeWithPreviewTabs(enabled: boolean): StoreApi<AppState> {
  const store = createEditorTabsStore()
  store.setState({ settings: createGlobalSettingsFixture({ editorPreviewTabsEnabled: enabled }) })
  return store
}

describe('editor preview tab setting', () => {
  it('replaces the open preview when preview tabs are enabled', () => {
    const store = storeWithPreviewTabs(true)

    openPreview(store, 'src/a.ts')
    openPreview(store, 'src/b.ts')

    expect(store.getState().openFiles.map((file) => file.relativePath)).toEqual(['src/b.ts'])
    expect(store.getState().openFiles[0].isPreview).toBe(true)
  })

  it('keeps both files open when preview tabs are disabled', () => {
    const store = storeWithPreviewTabs(false)

    openPreview(store, 'src/a.ts')
    openPreview(store, 'src/b.ts')

    expect(store.getState().openFiles.map((file) => file.relativePath)).toEqual([
      'src/a.ts',
      'src/b.ts'
    ])
    expect(store.getState().openFiles.every((file) => !file.isPreview)).toBe(true)
    expect(
      (store.getState().unifiedTabsByWorktree?.['wt-1'] ?? []).every((tab) => !tab.isPreview)
    ).toBe(true)
  })

  it('treats an unset setting as enabled so existing profiles keep preview tabs', () => {
    const store = createEditorTabsStore()

    openPreview(store, 'src/a.ts')
    openPreview(store, 'src/b.ts')

    expect(store.getState().openFiles.map((file) => file.relativePath)).toEqual(['src/b.ts'])
  })

  it('never evicts a preview restored from before the setting was turned off', () => {
    const store = storeWithPreviewTabs(true)
    openPreview(store, 'src/a.ts')

    store.setState({ settings: createGlobalSettingsFixture({ editorPreviewTabsEnabled: false }) })
    openPreview(store, 'src/b.ts')

    expect(store.getState().openFiles.map((file) => file.relativePath)).toEqual([
      'src/a.ts',
      'src/b.ts'
    ])
  })

  it('does not reuse a preview for a diff opened while preview tabs are disabled', () => {
    const store = storeWithPreviewTabs(false)

    store.getState().openDiff('wt-1', '/repo/src/a.ts', 'src/a.ts', 'typescript', false, {
      preview: true
    })
    store.getState().openDiff('wt-1', '/repo/src/b.ts', 'src/b.ts', 'typescript', false, {
      preview: true
    })

    expect(store.getState().openFiles.map((file) => file.relativePath)).toEqual([
      'src/a.ts',
      'src/b.ts'
    ])
  })

  it('leaves a flag set before the setting was turned off inert rather than reconciling it', () => {
    const store = storeWithPreviewTabs(true)
    openPreview(store, 'src/a.ts')
    expect(store.getState().openFiles[0].isPreview).toBe(true)

    // Why: nothing rewrites the stored flag when the setting flips, so every reader must gate on the setting.
    store.setState({ settings: createGlobalSettingsFixture({ editorPreviewTabsEnabled: false }) })

    expect(store.getState().openFiles[0].isPreview).toBe(true)
    expect(getReplaceablePreviewFileId(store.getState(), 'wt-1', undefined)).toBeNull()
  })

  it('makes the flag live again when the setting is turned back on', () => {
    const store = storeWithPreviewTabs(true)
    openPreview(store, 'src/a.ts')
    store.setState({ settings: createGlobalSettingsFixture({ editorPreviewTabsEnabled: false }) })
    store.setState({ settings: createGlobalSettingsFixture({ editorPreviewTabsEnabled: true }) })

    expect(getReplaceablePreviewFileId(store.getState(), 'wt-1', undefined)).toBe('/repo/src/a.ts')
  })
})
