import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COPILOT_MAX_DOCUMENT_CHARS } from '../../../../shared/copilot-inline-completion-types'
import { createFakeCopilotModel } from './fake-copilot-text-model-fixture'
import {
  closeCopilotDocumentForModel,
  flushPendingCopilotChange,
  onCopilotModelWithinSizeLimit,
  openCopilotDocumentForModel,
  reopenCopilotDocument
} from './monaco-copilot-documents'

const api = {
  openDocument: vi.fn(),
  changeDocument: vi.fn(),
  closeDocument: vi.fn()
}

beforeEach(() => {
  vi.useFakeTimers()
  api.openDocument.mockResolvedValue({ fileUri: 'file:///repo/a.ts' })
  api.changeDocument.mockResolvedValue(undefined)
  api.closeDocument.mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { copilotCompletion: api } })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const params = { filePath: '/repo/a.ts', rootPath: '/repo', languageId: 'typescript' }

describe('monaco copilot documents', () => {
  it('debounces edits into one full-text change and closes on last release', async () => {
    const { model, edit } = createFakeCopilotModel('a')
    const entry = await openCopilotDocumentForModel({ model, ...params })
    expect(entry?.fileUri).toBe('file:///repo/a.ts')
    edit('ab')
    edit('abc')
    expect(api.changeDocument).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(api.changeDocument).toHaveBeenCalledTimes(1)
    expect(api.changeDocument).toHaveBeenCalledWith({ fileUri: 'file:///repo/a.ts', text: 'abc' })
    closeCopilotDocumentForModel(model.uri.toString())
    expect(api.closeDocument).toHaveBeenCalledWith({ fileUri: 'file:///repo/a.ts' })
  })

  it('flushes a pending change before a completion request', async () => {
    const { model, edit } = createFakeCopilotModel('a')
    const entry = await openCopilotDocumentForModel({ model, ...params })
    edit('ab')
    await flushPendingCopilotChange(entry!)
    expect(api.changeDocument).toHaveBeenCalledWith({ fileUri: 'file:///repo/a.ts', text: 'ab' })
    closeCopilotDocumentForModel(model.uri.toString())
  })

  it('does not attach oversized models', async () => {
    const { model } = createFakeCopilotModel('x'.repeat(COPILOT_MAX_DOCUMENT_CHARS + 1))
    await expect(openCopilotDocumentForModel({ model, ...params })).resolves.toBeNull()
    expect(api.openDocument).not.toHaveBeenCalled()
  })

  it('stays detached when main returns no document (signed out or not installed)', async () => {
    api.openDocument.mockResolvedValue({ fileUri: null })
    const { model } = createFakeCopilotModel('a')
    await expect(openCopilotDocumentForModel({ model, ...params })).resolves.toBeNull()
  })

  it('closes a reopened document when the editor closed while the reopen was in flight', async () => {
    const { model } = createFakeCopilotModel('a')
    const entry = await openCopilotDocumentForModel({ model, ...params })
    let finishReopen: (value: { fileUri: string }) => void = () => {}
    api.openDocument.mockReturnValueOnce(new Promise((resolve) => (finishReopen = resolve)))
    const reopening = reopenCopilotDocument(entry!)
    closeCopilotDocumentForModel(model.uri.toString())
    api.closeDocument.mockClear()
    finishReopen({ fileUri: 'file:///repo/a.ts' })
    await reopening
    expect(api.closeDocument).toHaveBeenCalledWith({ fileUri: 'file:///repo/a.ts' })
  })

  it('keeps a reopened document open while its editor is still attached', async () => {
    const { model } = createFakeCopilotModel('a')
    const entry = await openCopilotDocumentForModel({ model, ...params })
    await reopenCopilotDocument(entry!)
    expect(api.closeDocument).not.toHaveBeenCalled()
    closeCopilotDocumentForModel(model.uri.toString())
  })

  it('reports an oversized model once it shrinks under the limit, then stops listening', () => {
    const { model, edit, listenerCount } = createFakeCopilotModel(
      'x'.repeat(COPILOT_MAX_DOCUMENT_CHARS + 1)
    )
    const onEligible = vi.fn()
    onCopilotModelWithinSizeLimit(model, onEligible)
    edit('x'.repeat(COPILOT_MAX_DOCUMENT_CHARS + 2))
    expect(onEligible).not.toHaveBeenCalled()
    edit('small')
    expect(onEligible).toHaveBeenCalledTimes(1)
    expect(listenerCount()).toBe(0)
  })
})
