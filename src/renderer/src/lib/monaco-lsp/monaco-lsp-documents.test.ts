import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'

vi.mock('@/lib/monaco-setup', () => ({
  monaco: {
    editor: { setModelMarkers: vi.fn() },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 }
  }
}))

import {
  closeLspDocumentForModel,
  getLspEntriesForSessionDocument,
  openLspDocumentForModel
} from './monaco-lsp-documents'

type FakeModel = editor.ITextModel & { setFakeValue: (text: string) => void }

function fakeModel(uri: string, text: string): FakeModel {
  let value = text
  return {
    uri: { toString: () => uri },
    getValue: () => value,
    isDisposed: () => false,
    onDidChangeContent: () => ({ dispose: vi.fn() }),
    setFakeValue: (next: string) => {
      value = next
    }
  } as unknown as FakeModel
}

const OPEN_RESULT = {
  sessionId: 'lsp-1',
  fileUri: 'file:///w/src/a.ts',
  serverId: 'tsgo',
  pullDiagnostics: false
}

const openParams = {
  filePath: '/w/src/a.ts',
  rootPath: '/w',
  worktreeId: 'wt-1',
  languageId: 'typescript'
}

function stubLspApi(): {
  openDocument: ReturnType<typeof vi.fn>
  changeDocument: ReturnType<typeof vi.fn>
} {
  const api = {
    openDocument: vi.fn().mockResolvedValue(OPEN_RESULT),
    changeDocument: vi.fn().mockResolvedValue(undefined),
    closeDocument: vi.fn().mockResolvedValue(undefined),
    request: vi.fn().mockResolvedValue(null),
    onDiagnostics: vi.fn(() => () => {})
  }
  ;(globalThis as { window?: unknown }).window ??= globalThis
  ;(window as { api?: unknown }).api = { lsp: api } as never
  return api
}

describe('openLspDocumentForModel', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fans diagnostics routing out to every surface of the same server document', async () => {
    stubLspApi()
    const tabModel = fakeModel('file:///w/src/a.ts', 'x')
    const diffModel = fakeModel('diff-section:wt-1:a:0:modified', 'x')
    await openLspDocumentForModel({ ...openParams, model: tabModel })
    await openLspDocumentForModel({ ...openParams, model: diffModel })
    expect(getLspEntriesForSessionDocument('lsp-1', OPEN_RESULT.fileUri)).toHaveLength(2)

    // Why: closing one surface must not delete the other surface's routing.
    closeLspDocumentForModel(tabModel.uri.toString(), () => {})
    const remaining = getLspEntriesForSessionDocument('lsp-1', OPEN_RESULT.fileUri)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].model).toBe(diffModel)
    closeLspDocumentForModel(diffModel.uri.toString(), () => {})
    expect(getLspEntriesForSessionDocument('lsp-1', OPEN_RESULT.fileUri)).toHaveLength(0)
  })

  it('re-syncs text that changed while the open round-trip was in flight', async () => {
    const api = stubLspApi()
    const model = fakeModel('file:///w/src/b.ts', 'before')
    api.openDocument.mockImplementation(async () => {
      model.setFakeValue('after keystrokes')
      return { ...OPEN_RESULT, fileUri: 'file:///w/src/b.ts' }
    })
    await openLspDocumentForModel({ ...openParams, filePath: '/w/src/b.ts', model })
    await vi.waitFor(() =>
      expect(api.changeDocument).toHaveBeenCalledWith({
        sessionId: 'lsp-1',
        fileUri: 'file:///w/src/b.ts',
        text: 'after keystrokes'
      })
    )
    closeLspDocumentForModel(model.uri.toString(), () => {})
  })
})
