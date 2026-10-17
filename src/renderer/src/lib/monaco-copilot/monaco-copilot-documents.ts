import type { IDisposable, editor } from 'monaco-editor'
import { COPILOT_MAX_DOCUMENT_CHARS } from '../../../../shared/copilot-inline-completion-types'

// Why: shorter than a typical language-server debounce -- ghost text is requested
// on nearly every keystroke and the provider flushes before asking anyway.
const CHANGE_DEBOUNCE_MS = 75

export type CopilotDocumentEntry = {
  modelUri: string
  fileUri: string
  filePath: string
  rootPath: string
  languageId: string
  model: editor.ITextModel
  refCount: number
  changeTimer: ReturnType<typeof setTimeout> | null
  lastSync: Promise<void>
  contentListener: IDisposable
  reopening: boolean
}

export type CopilotDocumentParams = {
  model: editor.ITextModel
  filePath: string
  rootPath: string
  languageId: string
}

const entriesByModelUri = new Map<string, CopilotDocumentEntry>()

export function isWithinCopilotSizeLimit(model: editor.ITextModel): boolean {
  return model.getValueLength() <= COPILOT_MAX_DOCUMENT_CHARS
}

/** Calls `onEligible` once when an oversized model shrinks back under the limit. */
export function onCopilotModelWithinSizeLimit(
  model: editor.ITextModel,
  onEligible: () => void
): IDisposable {
  const listener = model.onDidChangeContent(() => {
    if (isWithinCopilotSizeLimit(model)) {
      listener.dispose()
      onEligible()
    }
  })
  return listener
}

function sendChangeNow(entry: CopilotDocumentEntry): void {
  if (entry.changeTimer !== null) {
    clearTimeout(entry.changeTimer)
    entry.changeTimer = null
  }
  // Why: an oversized model is never sent; the provider stays silent until it shrinks and the next change resyncs.
  if (entry.model.isDisposed() || !isWithinCopilotSizeLimit(entry.model)) {
    return
  }
  const text = entry.model.getValue()
  entry.lastSync = entry.lastSync
    .then(() => window.api.copilotCompletion.changeDocument({ fileUri: entry.fileUri, text }))
    .catch(() => {})
}

export async function openCopilotDocumentForModel(
  params: CopilotDocumentParams
): Promise<CopilotDocumentEntry | null> {
  const { model, filePath, rootPath, languageId } = params
  const modelUri = model.uri.toString()
  const existing = entriesByModelUri.get(modelUri)
  if (existing) {
    existing.refCount++
    return existing
  }
  if (!isWithinCopilotSizeLimit(model)) {
    return null
  }
  const openedText = model.getValue()
  let fileUri: string | null
  try {
    ;({ fileUri } = await window.api.copilotCompletion.openDocument({
      filePath,
      rootPath,
      languageId,
      text: openedText
    }))
  } catch {
    return null
  }
  if (!fileUri) {
    return null
  }
  const raced = entriesByModelUri.get(modelUri)
  if (raced) {
    raced.refCount++
    void window.api.copilotCompletion.closeDocument({ fileUri }).catch(() => {})
    return raced
  }
  const entry: CopilotDocumentEntry = {
    modelUri,
    fileUri,
    filePath,
    rootPath,
    languageId,
    model,
    refCount: 1,
    changeTimer: null,
    lastSync: Promise.resolve(),
    reopening: false,
    contentListener: model.onDidChangeContent(() => {
      if (entry.changeTimer !== null) {
        clearTimeout(entry.changeTimer)
      }
      entry.changeTimer = setTimeout(() => sendChangeNow(entry), CHANGE_DEBOUNCE_MS)
    })
  }
  entriesByModelUri.set(modelUri, entry)
  if (!model.isDisposed() && model.getValue() !== openedText) {
    sendChangeNow(entry)
  }
  return entry
}

/** Re-sends the document after main lost it (the server restarted); the next request then succeeds. */
export async function reopenCopilotDocument(entry: CopilotDocumentEntry): Promise<void> {
  if (entry.reopening || entry.model.isDisposed() || !isWithinCopilotSizeLimit(entry.model)) {
    return
  }
  entry.reopening = true
  try {
    const { fileUri } = await window.api.copilotCompletion.openDocument({
      filePath: entry.filePath,
      rootPath: entry.rootPath,
      languageId: entry.languageId,
      text: entry.model.getValue()
    })
    // Why: the editor may have closed mid-reopen; that close was a no-op in main, so release the fresh open here.
    if (fileUri && entriesByModelUri.get(entry.modelUri) !== entry) {
      void window.api.copilotCompletion.closeDocument({ fileUri }).catch(() => {})
    }
  } catch {
    // The next request retries.
  } finally {
    entry.reopening = false
  }
}

export function flushPendingCopilotChange(entry: CopilotDocumentEntry): Promise<void> {
  if (entry.changeTimer !== null) {
    sendChangeNow(entry)
  }
  return entry.lastSync
}

export function getCopilotEntryForModelUri(modelUri: string): CopilotDocumentEntry | null {
  return entriesByModelUri.get(modelUri) ?? null
}

export function closeCopilotDocumentForModel(modelUri: string): void {
  const entry = entriesByModelUri.get(modelUri)
  if (!entry) {
    return
  }
  entry.refCount--
  if (entry.refCount > 0) {
    return
  }
  entriesByModelUri.delete(modelUri)
  entry.contentListener.dispose()
  if (entry.changeTimer !== null) {
    clearTimeout(entry.changeTimer)
    entry.changeTimer = null
  }
  void window.api.copilotCompletion.closeDocument({ fileUri: entry.fileUri }).catch(() => {})
}
