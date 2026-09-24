// Monaco providers + editor opener for language-server navigation (spec §4).
// F12/Ctrl+Click reach `registerEditorOpener` because the standalone
// `doOpenEditor` only opens the editor's CURRENT model — cross-file jumps are
// dead without it (spike findings §1, blocker B). The opener routes through the
// store's openFile flow, so target files become real tabs with models the
// document-sync bridge can then mirror to the session.
import type * as Monaco from 'monaco-editor'
import type {
  LanguageServerPosition,
  LanguageServerRange
} from '../../../../../shared/language-server-navigation-types'
import { normalizeNativeFilePath } from '../../../../../shared/language-server-path-normalization'
import { toEditorModelUri } from '../editor-model-uri'
import { nativePathForModel, resolveLocalDocumentOwner } from './editor-model-language-server-owner'
import { isPathInsideWorktree, toWorktreeRelativePath } from '@/lib/terminal-links'
import { detectLanguage } from '@/lib/language-detect'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'

const SELECTOR = ['cpp', 'c']

/** Monaco 1-based position -> IPC/LSP 0-based (UTF-16 basis both sides). */
function monacoPositionToLanguageServer(position: Monaco.Position): LanguageServerPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 }
}

/** IPC/LSP 0-based range -> Monaco 1-based. */
function languageServerRangeToMonaco(range: LanguageServerRange): Monaco.IRange {
  return {
    startLineNumber: range.startLine + 1,
    startColumn: range.startCharacter + 1,
    endLineNumber: range.endLine + 1,
    endColumn: range.endCharacter + 1
  }
}

function languageForNavigationTarget(targetPath: string, sourceLanguageId: string): string {
  const detected = detectLanguage(targetPath)
  // MSVC STL headers like `chrono` have no extension; detectLanguage would
  // hand them to Monaco as plaintext and lose highlighting entirely.
  return detected === 'plaintext' ? sourceLanguageId : detected
}

function revealPayloadFromSelection(
  selectionOrPosition: Monaco.IPosition | Monaco.IRange | undefined
): { line: number; column: number; matchLength: number } | null {
  if (!selectionOrPosition) {
    return null
  }
  if ('endLineNumber' in selectionOrPosition) {
    const range = selectionOrPosition
    const sameLine = range.endLineNumber === range.startLineNumber
    return {
      line: range.startLineNumber,
      column: range.startColumn,
      matchLength: sameLine ? Math.max(1, range.endColumn - range.startColumn) : 1
    }
  }
  const position = selectionOrPosition
  return {
    line: position.lineNumber,
    column: position.column,
    matchLength: 1
  }
}

/**
 * Registers definition + hover providers and the navigation editor opener.
 * Idempotent at the call site (monaco-setup runs once); returns disposables.
 */
export function installLanguageServerNavigationProviders(monaco: typeof Monaco): () => void {
  const definitionProvider = monaco.languages.registerDefinitionProvider(SELECTOR, {
    async provideDefinition(model, position) {
      const filePath = nativePathForModel(model)
      if (!filePath) {
        return null
      }
      if (!resolveLocalDocumentOwner(filePath)) {
        return null
      }
      const result = await window.api.languageServers.definition({
        filePath,
        position: monacoPositionToLanguageServer(position)
      })
      if (!result.ok || result.locations.length === 0) {
        return null
      }
      const target = result.locations[0]
      return {
        uri: monaco.Uri.parse(toEditorModelUri(target.path)),
        range: languageServerRangeToMonaco(target.range)
      }
    }
  })

  const hoverProvider = monaco.languages.registerHoverProvider(SELECTOR, {
    async provideHover(model, position) {
      const filePath = nativePathForModel(model)
      if (!filePath) {
        return null
      }
      if (!resolveLocalDocumentOwner(filePath)) {
        return null
      }
      const result = await window.api.languageServers.hover({
        filePath,
        position: monacoPositionToLanguageServer(position)
      })
      if (!result.ok || !result.hover?.value) {
        return null
      }
      // clangd returns markdown MarkupContent; Monaco's MarkedString {value}
      // shape renders it. Null hover already returned null -> no popup.
      const word = model.getWordAtPosition(position)
      return {
        contents: [{ value: result.hover.value }],
        range: word
          ? {
              startLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endLineNumber: position.lineNumber,
              endColumn: word.endColumn
            }
          : undefined
      }
    }
  })

  const opener = monaco.editor.registerEditorOpener({
    openCodeEditor: async (source, resource, selectionOrPosition) => {
      if (resource.scheme !== 'file') {
        return false
      }
      const sourceModel = source.getModel()
      const sourcePath = sourceModel ? nativePathForModel(sourceModel) : null
      const owner = sourcePath ? resolveLocalDocumentOwner(sourcePath) : null
      // Only navigation whose source document has a native session participates
      // (spec D10: files without a worktree owner degrade to no navigation).
      if (!owner || !sourceModel) {
        return false
      }
      const targetPath = normalizeNativeFilePath(resource.fsPath)
      const withinWorktree = isPathInsideWorktree(targetPath, owner.worktreeRoot)
      const relativePath = withinWorktree
        ? (toWorktreeRelativePath(targetPath, owner.worktreeRoot) ?? targetPath)
        : targetPath
      const language = languageForNavigationTarget(targetPath, sourceModel.getLanguageId())

      if (!withinWorktree) {
        // Project-external target (e.g. an MSVC STL header): the external-file
        // contract keeps relativePath === filePath after the authorization
        // grant; read-only matches the AI Vault log precedent and keeps
        // autosave from ever writing into system directories.
        try {
          await window.api.fs.authorizeExternalPath({ targetPath })
        } catch {
          return false
        }
      }

      const state = useAppStore.getState()
      if (state.activeWorktreeId !== owner.worktreeId) {
        activateAndRevealWorkspace(owner.worktreeId, { providesInitialSurface: true })
      }
      const fileId = state.openFile(
        {
          filePath: targetPath,
          relativePath,
          worktreeId: owner.worktreeId,
          language,
          mode: 'edit',
          runtimeEnvironmentId: null,
          ...(withinWorktree ? {} : { readOnly: true })
        },
        {
          preview: false,
          forceContentReload: true,
          // Pin local ownership: an active remote runtime must not reinterpret
          // the native host's navigation target as its own path.
          suppressActiveRuntimeFallback: true
        }
      )

      const reveal = revealPayloadFromSelection(selectionOrPosition)
      if (reveal) {
        state.setPendingEditorReveal(null)
        state.setPendingEditorReveal({
          filePath: targetPath,
          fileId,
          line: reveal.line,
          column: reveal.column,
          matchLength: reveal.matchLength
        })
      }
      return true
    }
  })

  return () => {
    definitionProvider.dispose()
    hoverProvider.dispose()
    opener.dispose()
  }
}
