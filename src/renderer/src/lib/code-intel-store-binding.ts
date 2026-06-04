import * as monaco from 'monaco-editor'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import { setCodeIntelEditorContext } from './code-intel-editor-context'
import { setTypeScriptNavigationMode } from './monaco-typescript-navigation-mode'

function samePath(a: string, b: string): boolean {
  return normalizeRuntimePathForComparison(a) === normalizeRuntimePathForComparison(b)
}

// Why: @monaco-editor/react builds the model URI from the absolute file path we
// pass as `path`, so the open editor tab is found by matching that path.
function findOpenFileByModelPath(modelPath: string) {
  return useAppStore.getState().openFiles.find((file) => samePath(file.filePath, modelPath))
}

function isExperimentalCodeIntelEnabled(): boolean {
  return useAppStore.getState().settings?.experimentalCodeIntelligence ?? false
}

function syncTypeScriptNavigationMode(): void {
  setTypeScriptNavigationMode(isExperimentalCodeIntelEnabled())
}

function extractPosition(selectionOrPosition: monaco.IRange | monaco.IPosition | undefined): {
  line: number
  column: number
} {
  if (!selectionOrPosition) {
    return { line: 1, column: 1 }
  }
  if ('startLineNumber' in selectionOrPosition) {
    return {
      line: selectionOrPosition.startLineNumber,
      column: selectionOrPosition.startColumn
    }
  }
  return { line: selectionOrPosition.lineNumber, column: selectionOrPosition.column }
}

let installed = false

/**
 * Wires the code-intel Monaco providers to the renderer store: resolves which
 * worktree a model belongs to (so the sidecar is queried at all) and registers
 * an editor opener so "go to definition" can navigate to another file — which
 * Monaco's standalone editor refuses to do on its own.
 */
export function installCodeIntelStoreBinding(): void {
  if (installed) {
    return
  }
  installed = true

  setCodeIntelEditorContext(
    (model) => {
      const state = useAppStore.getState()
      const file = findOpenFileByModelPath(model.uri.path)
      if (!file) {
        return null
      }
      const worktree = findWorktreeById(state.worktreesByRepo ?? {}, file.worktreeId)
      if (!worktree?.path) {
        return null
      }
      const repo = (state.repos ?? []).find((candidate) => candidate.id === worktree.repoId)
      return {
        worktreeRoot: worktree.path,
        filePath: file.filePath,
        connectionId: repo?.connectionId ?? undefined,
        isDirty: file.isDirty
      }
    },
    () => useAppStore.getState().settings?.experimentalCodeIntelligence ?? false
  )
  syncTypeScriptNavigationMode()
  useAppStore.subscribe((state, previousState) => {
    const enabled = state.settings?.experimentalCodeIntelligence ?? false
    const previousEnabled = previousState.settings?.experimentalCodeIntelligence ?? false
    if (enabled !== previousEnabled) {
      setTypeScriptNavigationMode(enabled)
    }
  })

  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      const state = useAppStore.getState()
      if (!state.settings?.experimentalCodeIntelligence) {
        return false
      }
      const sourceModel = source.getModel()
      if (!sourceModel) {
        return false
      }
      // Why: same-file targets are handled by Monaco's default reveal; only
      // cross-file navigation needs us to open a new tab.
      if (samePath(sourceModel.uri.path, resource.path)) {
        return false
      }
      const sourceFile = findOpenFileByModelPath(sourceModel.uri.path)
      if (!sourceFile) {
        return false
      }
      const { line, column } = extractPosition(selectionOrPosition)
      state.openCodeIntelDefinition({
        sourceFilePath: sourceFile.filePath,
        targetFilePath: resource.fsPath,
        line,
        column
      })
      return true
    }
  })
}
