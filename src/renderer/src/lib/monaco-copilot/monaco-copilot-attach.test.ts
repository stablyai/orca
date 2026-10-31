import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COPILOT_MAX_DOCUMENT_CHARS } from '../../../../shared/copilot-inline-completion-types'
import { createFakeCopilotModel } from './fake-copilot-text-model-fixture'
import { attachMonacoCopilotDocument } from './monaco-copilot-attach'

vi.mock('@/lib/monaco-setup', () => ({
  monaco: {
    languages: {
      registerInlineCompletionsProvider: () => ({ dispose: () => {} }),
      InlineCompletionTriggerKind: { Explicit: 1 }
    }
  }
}))

const api = { openDocument: vi.fn(), changeDocument: vi.fn(), closeDocument: vi.fn() }
const params = { filePath: '/repo/a.ts', rootPath: '/repo', languageId: 'typescript' }

beforeEach(() => {
  api.openDocument.mockResolvedValue({ fileUri: 'file:///repo/a.ts' })
  api.changeDocument.mockResolvedValue(undefined)
  api.closeDocument.mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { copilotCompletion: api } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('attachMonacoCopilotDocument', () => {
  it('attaches an initially oversized model once it shrinks under the limit', async () => {
    const { model, edit } = createFakeCopilotModel('x'.repeat(COPILOT_MAX_DOCUMENT_CHARS + 1))
    const detach = attachMonacoCopilotDocument({ model, ...params })
    expect(api.openDocument).not.toHaveBeenCalled()
    edit('small')
    await vi.waitFor(() => expect(api.openDocument).toHaveBeenCalledTimes(1))
    detach()
    await vi.waitFor(() =>
      expect(api.closeDocument).toHaveBeenCalledWith({ fileUri: 'file:///repo/a.ts' })
    )
  })

  it('stops waiting for a shrink once detached', () => {
    const { model, edit, listenerCount } = createFakeCopilotModel(
      'x'.repeat(COPILOT_MAX_DOCUMENT_CHARS + 1)
    )
    const detach = attachMonacoCopilotDocument({ model, ...params })
    expect(listenerCount()).toBe(1)
    detach()
    edit('small')
    expect(listenerCount()).toBe(0)
    expect(api.openDocument).not.toHaveBeenCalled()
  })

  it('retries a rejected open a bounded number of times while attached', async () => {
    vi.useFakeTimers()
    try {
      api.openDocument.mockResolvedValue({ fileUri: null })
      const { model } = createFakeCopilotModel('a')
      const detach = attachMonacoCopilotDocument({ model, ...params })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(api.openDocument).toHaveBeenCalledTimes(2)
      api.openDocument.mockResolvedValue({ fileUri: 'file:///repo/a.ts' })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(api.openDocument).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(api.openDocument).toHaveBeenCalledTimes(3)
      detach()
      expect(api.closeDocument).toHaveBeenCalledWith({ fileUri: 'file:///repo/a.ts' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up after the retry budget and cancels pending retries on detach', async () => {
    vi.useFakeTimers()
    try {
      api.openDocument.mockResolvedValue({ fileUri: null })
      const { model } = createFakeCopilotModel('a')
      const detach = attachMonacoCopilotDocument({ model, ...params })
      await vi.advanceTimersByTimeAsync(120_000)
      expect(api.openDocument).toHaveBeenCalledTimes(4)
      const second = attachMonacoCopilotDocument({ model, ...params })
      await vi.advanceTimersByTimeAsync(0)
      second()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(api.openDocument).toHaveBeenCalledTimes(5)
      detach()
    } finally {
      vi.useRealTimers()
    }
  })
})
