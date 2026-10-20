import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import type { AppState } from '../store/types'
import { buildEditorSessionData } from '../lib/workspace-session'
import { sameOpenFiles } from './web-session-tabs-sync/state-equality-files'
import { buildRuntimeMobileOpenFilesProjection } from './sync-runtime-graph/sync-projections'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph/mobile-session-snapshots'
import { makeState } from './sync-runtime-graph-test-harness'
import { attachMobileMarkdownBridge } from './mobile-markdown-bridge'
import {
  cleanupMobileMarkdownBridgeHarness,
  openMarkdownFile,
  resetEditorState,
  sendRequest,
  setupWindow
} from './mobile-markdown-bridge-test-harness'

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: () => null
}))

const FILE_ID = '/repo/README.md'

/** Dirties the tab through its buffer record and returns the store on either side. */
function dirtyThroughRecord(): { before: AppState; after: AppState } {
  const before = useAppStore.getState()
  before.markFileDirty(FILE_ID, true)
  const after = useAppStore.getState()
  expect(after.editorBuffers[FILE_ID]?.isDirty).toBe(true)
  return { before, after }
}

describe('a dirty change on the buffer record reaches every openFiles reader', () => {
  beforeEach(() => {
    resetEditorState()
    openMarkdownFile()
  })

  afterEach(() => {
    cleanupMobileMarkdownBridgeHarness()
  })

  it('web session tab sync sees the open files change', () => {
    const { before, after } = dirtyThroughRecord()

    expect(sameOpenFiles(before.openFiles, after.openFiles)).toBe(false)
  })

  it('session save persists the draft of the now-dirty tab', () => {
    useAppStore.getState().setEditorDraft(FILE_ID, '# edited\n')
    const save = (state: AppState) =>
      buildEditorSessionData(
        state.openFiles,
        state.editorDrafts,
        state.markdownFrontmatterVisible,
        state.activeFileIdByWorktree,
        state.activeTabTypeByWorktree
      ).openFilesByWorktree?.['wt-1']?.[0]?.dirtyDraftContent

    const { before, after } = dirtyThroughRecord()

    expect(save(before)).toBeUndefined()
    expect(save(after)).toBe('# edited\n')
  })

  it('mobile session projections publish the dirty flag', () => {
    const { before, after } = dirtyThroughRecord()
    const markdownTab = (state: AppState) =>
      buildMobileSessionTabSnapshots(
        makeState({
          openFiles: state.openFiles,
          editorDrafts: state.editorDrafts,
          unifiedTabsByWorktree: state.unifiedTabsByWorktree,
          tabBarOrderByWorktree: { 'wt-1': [FILE_ID] }
        })
      )[0]?.tabs.find((tab) => tab.type === 'markdown')

    expect(buildRuntimeMobileOpenFilesProjection(after.openFiles)).not.toBe(
      buildRuntimeMobileOpenFilesProjection(before.openFiles)
    )
    expect(markdownTab(before)).toMatchObject({ isDirty: false })
    expect(markdownTab(after)).toMatchObject({ isDirty: true })
  })

  it('the mobile markdown bridge reports the tab dirty', async () => {
    setupWindow({
      readFile: vi.fn().mockResolvedValue({ content: 'disk', isBinary: false })
    })
    const detach = attachMobileMarkdownBridge()
    dirtyThroughRecord()

    try {
      const response = await sendRequest({
        id: 'read-dirty',
        operation: 'read',
        worktreeId: 'wt-1',
        tabId: 'tab-md'
      })

      expect(response).toMatchObject({
        ok: true,
        result: { source: 'file', isDirty: true }
      })
    } finally {
      detach()
    }
  })
})
