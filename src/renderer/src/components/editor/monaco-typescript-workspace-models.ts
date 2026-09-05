import { useEffect } from 'react'
import { monaco } from '@/lib/monaco-setup'
import { useAppStore } from '@/store'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { getRelativePathInsideRoot } from '@/lib/path'
import { detectLanguage } from '@/lib/language-detect'
import { isMacUserAgent } from '../terminal-pane/pane-helpers'
import {
  deriveWorkspaceRootPath,
  isLocalTypeScriptWorkspaceConnection,
  isTypeScriptWorkspaceLanguage
} from './monaco-typescript-workspace-model-policy'
import { readWorkspaceModels } from './monaco-typescript-workspace-model-hydration'

type MonacoTypeScriptWorkspaceModelParams = {
  filePath: string
  relativePath: string
  worktreeId?: string
  runtimeEnvironmentId?: string | null
  language: string
  modelUri?: string
}

type HydrationRecord = {
  promise: Promise<void>
}

const hydrationByWorkspace = new Map<string, HydrationRecord>()

export function getMonacoFileModelUri(filePath: string): string {
  return monaco.Uri.file(filePath).toString()
}

export function resolveMonacoTypeScriptWorkspaceRoot(
  filePath: string,
  relativePath: string,
  worktreeId?: string
): string | null {
  const state = useAppStore.getState()
  const worktree = Object.values(state.worktreesByRepo)
    .flat()
    .find(
      (candidate) =>
        candidate.id === worktreeId && getRelativePathInsideRoot(filePath, candidate.path) !== null
    )
  return deriveWorkspaceRootPath({ filePath, relativePath, worktreePath: worktree?.path })
}

function findWorktreeForFilePath(filePath: string): { id: string; path: string } | null {
  return (
    Object.values(useAppStore.getState().worktreesByRepo)
      .flat()
      .find((candidate) => getRelativePathInsideRoot(filePath, candidate.path) !== null) ?? null
  )
}

function getDefinitionOpenerRange(
  selectionOrPosition: monaco.IRange | monaco.IPosition | undefined
): { startLineNumber: number; startColumn: number; endColumn: number } {
  if (selectionOrPosition && 'startLineNumber' in selectionOrPosition) {
    return selectionOrPosition
  }
  const position = selectionOrPosition ?? { lineNumber: 1, column: 1 }
  return {
    startLineNumber: position.lineNumber,
    startColumn: position.column,
    endColumn: position.column
  }
}

// Why: bridges Monaco's built-in F12/Peek Definition navigation (which only knows how to jump
// within its own already-open model) to Orca's own tabs — without this, cross-file navigation
// only works through the Cmd/Ctrl+Click handler below. Registered once at module scope since
// Monaco's editor-opener registry is global, not per-editor-instance.
monaco.editor.registerEditorOpener({
  openCodeEditor: (_source, resource, selectionOrPosition) => {
    const filePath = resource.fsPath
    const worktree = findWorktreeForFilePath(filePath)
    if (
      !worktree ||
      !isLocalTypeScriptWorkspaceConnection(getConnectionIdForFile(worktree.id, filePath))
    ) {
      return false
    }
    const relativePath = getRelativePathInsideRoot(filePath, worktree.path) ?? filePath
    const range = getDefinitionOpenerRange(selectionOrPosition)
    const state = useAppStore.getState()
    const fileId = state.openFile(
      {
        filePath,
        relativePath,
        worktreeId: worktree.id,
        language: detectLanguage(relativePath),
        mode: 'edit'
      },
      { focusEditor: true }
    )
    state.setPendingEditorReveal(null)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        useAppStore.getState().setPendingEditorReveal({
          filePath,
          fileId,
          line: range.startLineNumber,
          column: range.startColumn,
          matchLength: Math.max(0, range.endColumn - range.startColumn)
        })
      })
    })
    return true
  }
})

export function installMonacoTypeScriptDefinitionNavigation({
  editor,
  filePath,
  modelUri,
  worktreeId,
  onDefinition
}: {
  editor: monaco.editor.ICodeEditor
  filePath: string
  modelUri: string
  worktreeId?: string
  onDefinition: (definition: {
    filePath: string
    range: {
      startLineNumber: number
      startColumn: number
      endLineNumber: number
      endColumn: number
    }
  }) => void
}): monaco.IDisposable {
  const disposable = editor.onMouseDown((event) => {
    const modifierPressed = isMacUserAgent() ? event.event.metaKey : event.event.ctrlKey
    if (!event.event.leftButton || !modifierPressed) {
      return
    }
    const position = event.target.position
    const model = editor.getModel()
    if (!position || !model || model.uri.toString() !== modelUri) {
      return
    }
    const rootPath = Object.values(useAppStore.getState().worktreesByRepo)
      .flat()
      .find(
        (candidate) =>
          candidate.id === worktreeId && getRelativePathInsideRoot(filePath, candidate.path)
      )?.path
    if (!rootPath) {
      return
    }
    if (
      !isLocalTypeScriptWorkspaceConnection(getConnectionIdForFile(worktreeId ?? null, filePath))
    ) {
      return
    }
    event.event.preventDefault()
    event.event.stopPropagation()
    void window.api.editorLanguage
      .getDefinition({
        rootPath,
        filePath,
        content: model.getValue(),
        position
      })
      .then((definition) => {
        if (definition) {
          onDefinition(definition)
        }
      })
      .catch((error) => {
        console.warn('[editor] failed to open TypeScript definition', error)
      })
  })
  return disposable
}

export function useMonacoTypeScriptWorkspaceModels({
  filePath,
  relativePath,
  worktreeId,
  runtimeEnvironmentId,
  language,
  modelUri: modelUriOverride
}: MonacoTypeScriptWorkspaceModelParams): void {
  useEffect(() => {
    if (!isTypeScriptWorkspaceLanguage(language) || runtimeEnvironmentId?.trim()) {
      return
    }
    const rootPath = resolveMonacoTypeScriptWorkspaceRoot(filePath, relativePath, worktreeId)
    if (!rootPath) {
      return
    }
    const connectionId = getConnectionIdForFile(worktreeId ?? null, filePath) ?? undefined
    const hydrationKey = `${connectionId ?? 'local'}\0${rootPath}`
    if (hydrationByWorkspace.has(hydrationKey)) {
      return
    }
    const promise = readWorkspaceModels({ rootPath, connectionId }).catch((error) => {
      hydrationByWorkspace.delete(hydrationKey)
      console.warn('[editor] failed to hydrate TypeScript workspace models', error)
    })
    hydrationByWorkspace.set(hydrationKey, { promise })
    void promise
  }, [filePath, language, relativePath, runtimeEnvironmentId, worktreeId])

  useEffect(() => {
    if (!isTypeScriptWorkspaceLanguage(language) || runtimeEnvironmentId?.trim()) {
      return
    }
    const rootPath = resolveMonacoTypeScriptWorkspaceRoot(filePath, relativePath, worktreeId)
    if (!rootPath) {
      return
    }
    const modelUri = modelUriOverride ?? getMonacoFileModelUri(filePath)

    const definitionProvider = monaco.languages.registerDefinitionProvider(language, {
      provideDefinition: async (model, position) => {
        if (model.uri.toString() !== modelUri) {
          return null
        }
        if (
          !isLocalTypeScriptWorkspaceConnection(
            getConnectionIdForFile(worktreeId ?? null, filePath)
          )
        ) {
          return null
        }
        const result = await window.api.editorLanguage.getDefinition({
          rootPath,
          filePath,
          content: model.getValue(),
          position
        })
        if (!result) {
          return null
        }
        return {
          uri: monaco.Uri.file(result.filePath),
          range: new monaco.Range(
            result.range.startLineNumber,
            result.range.startColumn,
            result.range.endLineNumber,
            result.range.endColumn
          )
        }
      }
    })

    return () => {
      definitionProvider.dispose()
    }
  }, [filePath, language, modelUriOverride, relativePath, runtimeEnvironmentId, worktreeId])
}
