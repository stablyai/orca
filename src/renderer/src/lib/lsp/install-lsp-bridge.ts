// src/renderer/src/lib/lsp/install-lsp-bridge.ts
import type * as Monaco from 'monaco-editor'
import { typescript as monacoTS } from 'monaco-editor'
import { useAppStore } from '@/store'
import { getWorktreeMapFromState } from '@/store/selectors'
import { LspDocumentSync } from './lsp-document-sync'
import { registerLspEditorOpener } from './lsp-editor-opener'
import { registerLspNavigationProviders } from './lsp-navigation-providers'
import { findOwningWorktree } from './lsp-owning-worktree'
import { registerLspSemanticTokensProvider } from './lsp-semantic-tokens'
import { getLspClient, releaseLspClient, retainLspClient } from './lsp-session-opener'

function findOwner(fsPath: string) {
  return findOwningWorktree(getWorktreeMapFromState(useAppStore.getState()).values(), fsPath)
}

function disableWorkerNavigation(): void {
  // Why: the LSP providers fall back to the worker themselves; its own providers would duplicate results.
  for (const defaults of [monacoTS.typescriptDefaults, monacoTS.javascriptDefaults]) {
    defaults.setModeConfiguration({
      ...defaults.modeConfiguration,
      hovers: false,
      definitions: false,
      references: false
    })
  }
}

export function installLspBridge(monaco: typeof Monaco): () => void {
  const sync = new LspDocumentSync({
    findOwner,
    getClient: getLspClient,
    retainClient: retainLspClient,
    releaseClient: releaseLspClient
  })
  const disposables: Monaco.IDisposable[] = [
    monaco.editor.onDidCreateModel((model) => sync.track(model)),
    ...registerLspNavigationProviders(monaco, sync),
    registerLspSemanticTokensProvider(monaco, sync),
    registerLspEditorOpener(monaco, findOwner)
  ]
  monaco.editor.getModels().forEach((model) => sync.track(model))
  disableWorkerNavigation()
  return () => {
    disposables.forEach((disposable) => disposable.dispose())
  }
}
