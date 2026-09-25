// Document sync bridge (spec D4): model lifecycle -> didOpen/didChange/didClose
// over the languageServers IPC facade. Change events are translated as-is from
// Monaco's model `onDidChangeContent` (note: the MODEL event — the editor-level
// `onDidChangeModelContent` is a different API) into 0-based semantic changes.
//
// Every real content change reaches clangd: user typing, undo, multi-change
// gestures AND programmatic reconciliations (external reload while mounted).
// App-driven reloads land as full-range replacements, which are valid LSP
// incremental changes, and model recreation goes through didOpen — so no
// separate full-text resend point is needed. Self-write echoes never produce
// model events at all: the self-write registry suppresses the watcher reload
// chain for Orca's own saves.
import type * as Monaco from 'monaco-editor'
import type { LanguageServerDocumentChange } from '../../../../../shared/language-server-navigation-types'
import {
  isNativeNavigationLanguage,
  nativePathForModel,
  resolveLocalDocumentOwner
} from './editor-model-language-server-owner'

type SyncedModel = {
  filePath: string
  version: number
  /** Serializes this document's IPC traffic; changes wait for didOpen. */
  pipeline: Promise<unknown>
  listeners: Monaco.IDisposable[]
}

function monacoRangeToLanguageServerRange(
  range: Monaco.IRange
): LanguageServerDocumentChange['range'] {
  return {
    startLine: range.startLineNumber - 1,
    startCharacter: range.startColumn - 1,
    endLine: range.endLineNumber - 1,
    endCharacter: range.endColumn - 1
  }
}

/**
 * Watches C/C++ file models on the client-local host and mirrors their content
 * into the language-server host. Idempotent; returns an uninstall function.
 */
export function installLanguageServerDocumentSync(monaco: typeof Monaco): () => void {
  const synced = new Map<string, SyncedModel>()

  const trackModel = (model: Monaco.editor.ITextModel): void => {
    if (!isNativeNavigationLanguage(model.getLanguageId())) {
      return
    }
    const filePath = nativePathForModel(model)
    if (!filePath || synced.has(filePath)) {
      return
    }
    const owner = resolveLocalDocumentOwner(filePath)
    if (!owner) {
      // No local worktree owns this document yet (e.g. model retained after
      // its tab closed) — expected no-navigation degradation (spec D10).
      return
    }
    const entry: SyncedModel = {
      filePath,
      version: 1,
      pipeline: Promise.resolve(),
      listeners: []
    }
    synced.set(filePath, entry)
    // didOpen carries the MODEL text, not the disk text: restored drafts and
    // in-flight autosaves make those two differ.
    entry.pipeline = entry.pipeline.then(() =>
      window.api.languageServers.openDocument({
        worktreeRoot: owner.worktreeRoot,
        filePath,
        text: model.getValue(),
        connectionId: owner.connectionId ?? null
      })
    )
    entry.listeners.push(
      model.onDidChangeContent((event) => {
        // One event per gesture; the changes array maps 1:1 onto LSP
        // contentChanges after the 0/1-based shift (spike findings §2).
        entry.version += 1
        const version = entry.version
        const changes = event.changes.map((change) => ({
          range: monacoRangeToLanguageServerRange(change.range),
          rangeLength: change.rangeLength,
          text: change.text
        }))
        entry.pipeline = entry.pipeline.then(() =>
          window.api.languageServers.changeDocument({ filePath, version, changes })
        )
      }),
      model.onWillDispose(() => {
        synced.delete(filePath)
        entry.pipeline = entry.pipeline.then(() =>
          window.api.languageServers.closeDocument({ filePath })
        )
      })
    )
  }

  // Defensive sweep: monaco-setup runs before any editor mounts, but a second
  // install (HMR) must not miss models that already exist.
  for (const model of monaco.editor.getModels()) {
    trackModel(model)
  }
  const createdSub = monaco.editor.onDidCreateModel((model) => trackModel(model))

  return () => {
    createdSub.dispose()
    for (const entry of synced.values()) {
      for (const listener of entry.listeners) {
        listener.dispose()
      }
      entry.pipeline = entry.pipeline.then(() =>
        window.api.languageServers.closeDocument({ filePath: entry.filePath })
      )
    }
    synced.clear()
  }
}
