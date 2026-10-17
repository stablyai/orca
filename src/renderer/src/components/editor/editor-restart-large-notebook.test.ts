// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorPrepareHotExitDetail } from '../../../../shared/editor-save-events'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import {
  ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT,
  type EditorRequestFileCloseDetail
} from './editor-autosave'
import { createEditorRestartSaveHandlers } from './editor-restart-save-handlers'

const LARGE = 'x'.repeat(10_000 * 1024 + 1)

function createHandlers(drafts: Record<string, string>) {
  const store = createEditorStore()
  store.setState({
    workspaceSessionReady: true,
    hydrationSucceeded: true,
    browserTabsByWorktree: {},
    tabsByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    unifiedTabsByWorktree: {}
  })
  for (const [name, draft] of Object.entries(drafts)) {
    store.getState().openFile({
      filePath: `/repo/${name}`,
      relativePath: name,
      worktreeId: 'wt-1',
      language: 'notebook',
      mode: 'edit'
    })
    store.getState().setEditorDraft(`/repo/${name}`, draft)
    store.getState().markFileDirty(`/repo/${name}`, true)
  }
  const handlers = createEditorRestartSaveHandlers({
    store,
    queueSave: vi.fn(),
    quiesceFileSave: vi.fn(async () => {})
  })
  return { handlers, close: (fileId: string) => store.getState().closeFile(fileId) }
}

function prepareHotExit(handlers: ReturnType<typeof createHandlers>['handlers']): Promise<void> {
  return new Promise((resolve, reject) => {
    const detail: EditorPrepareHotExitDetail = {
      claim: () => {},
      resolve,
      reject: (message) => reject(new Error(message))
    }
    void handlers.handlePrepareHotExit(new CustomEvent('prepare', { detail }))
  })
}

describe('restart with a notebook too large to back up', () => {
  let requests: EditorRequestFileCloseDetail[]
  const listener = (event: Event): void => {
    if (event instanceof CustomEvent) {
      const detail: EditorRequestFileCloseDetail = event.detail
      detail.claim?.()
      requests.push(detail)
    }
  }

  beforeEach(() => {
    requests = []
    window.addEventListener(ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT, listener)
  })

  afterEach(() => {
    window.removeEventListener(ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT, listener)
  })

  it('asks to save it first, then restarts once it closes', async () => {
    const { handlers, close } = createHandlers({ 'big.ipynb': LARGE, 'small.ipynb': '{}' })
    const prepared = prepareHotExit(handlers)
    await vi.waitFor(() =>
      expect(requests.map((request) => request.fileId)).toEqual(['/repo/big.ipynb'])
    )
    close('/repo/big.ipynb')
    requests[0]?.onClosed?.()
    await expect(prepared).resolves.toBeUndefined()
  })

  it('cancels the restart when the user cancels the prompt', async () => {
    const { handlers } = createHandlers({ 'big.ipynb': LARGE })
    const prepared = prepareHotExit(handlers)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    requests[0]?.onCancelled?.()
    await expect(prepared).rejects.toThrow('a large notebook has unsaved changes')
  })

  it('cancels the restart when nothing can ask', async () => {
    window.removeEventListener(ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT, listener)
    const { handlers } = createHandlers({ 'big.ipynb': LARGE })
    await expect(prepareHotExit(handlers)).rejects.toThrow('a large notebook has unsaved changes')
  })

  it('does not ask about drafts it can back up', async () => {
    const { handlers } = createHandlers({ 'small.ipynb': '{}' })
    await expect(prepareHotExit(handlers)).resolves.toBeUndefined()
    expect(requests).toHaveLength(0)
  })
})
