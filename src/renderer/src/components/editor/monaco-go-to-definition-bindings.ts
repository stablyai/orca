import type { OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { translate } from '@/i18n/i18n'
import { detectLanguage } from '@/lib/language-detect'
import { getRelativePathInsideRoot, joinPath, normalizeRelativePath } from '@/lib/path'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { useAppStore } from '@/store'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { installEditorGoToDefinitionShortcut } from './editor-shortcuts'
import { runGoToDefinition } from './go-to-definition-controller'
import { isGoToDefinitionMouseGesture } from './go-to-definition-mouse-gesture'
import { getMonacoCodebaseSearchQuery } from './monaco-codebase-search'

type MonacoApi = Parameters<OnMount>[1]

type MonacoGoToDefinitionBindingsParams = {
  editorInstance: editor.IStandaloneCodeEditor
  monaco: MonacoApi
  filePath: string
  relativePath: string
  worktreeId: string | undefined
}

function deriveWorktreeRoot(filePath: string, relativePath: string): string | null {
  const segments = normalizeRelativePath(relativePath).split('/').filter(Boolean)
  if (segments.length === 0) {
    return null
  }

  let root = filePath.replace(/[\\/]+$/, '')
  for (let index = 0; index < segments.length; index++) {
    const separatorIndex = Math.max(root.lastIndexOf('/'), root.lastIndexOf('\\'))
    if (separatorIndex < 0) {
      return null
    }
    const keepRootSeparator =
      separatorIndex === 0 || (separatorIndex === 2 && /^[A-Za-z]:[\\/]/.test(root))
    root = root.slice(0, keepRootSeparator ? separatorIndex + 1 : separatorIndex)
  }

  const reconstructedPath = joinPath(root, relativePath)
  return normalizeRuntimePathForComparison(reconstructedPath) ===
    normalizeRuntimePathForComparison(filePath)
    ? root
    : null
}

export function installMonacoGoToDefinitionBindings(
  params: MonacoGoToDefinitionBindingsParams
): () => void {
  const { editorInstance, monaco, filePath, relativePath, worktreeId } = params
  const editorDomNode = editorInstance.getContainerDomNode()
  const worktreeRoot = deriveWorktreeRoot(filePath, relativePath)

  const trigger = (): void => {
    const api = (window as Window & { api?: Window['api'] }).api?.symbolIndex
    const position = editorInstance.getPosition()
    const symbol = getMonacoCodebaseSearchQuery(
      editorInstance.getModel(),
      editorInstance.getSelection(),
      position
    )
    const state = useAppStore.getState()
    if (!api) {
      if (symbol) {
        state.showRightSidebarSearch({ query: symbol })
      }
      return
    }

    const openDefinition = (target: { path: string; line: number; column: number }): void => {
      if (!worktreeId) {
        return
      }
      state.openFile({
        filePath: target.path,
        relativePath: getRelativePathInsideRoot(target.path, worktreeRoot) ?? target.path,
        worktreeId,
        language: detectLanguage(target.path),
        mode: 'edit'
      })
      state.setPendingEditorReveal({
        filePath: target.path,
        line: target.line,
        column: target.column,
        matchLength: 0
      })
    }

    void runGoToDefinition({
      worktreeId: worktreeId ?? null,
      worktreeRoot,
      currentPath: filePath,
      currentLine: position?.lineNumber ?? 1,
      symbol,
      find: async (request) => {
        const response = await api.findDefinitions(request)
        return response && typeof response === 'object' && 'status' in response
          ? response
          : { status: 'indexing', definitions: [] }
      },
      openAt: openDefinition,
      peek: (targets) => {
        const first = targets[0]
        if (first) {
          openDefinition(first)
        }
        if (symbol) {
          state.showRightSidebarSearch({ query: symbol })
        }
      },
      fallback: () => {
        if (symbol) {
          state.showRightSidebarSearch({ query: symbol })
        }
      }
    })
  }

  const action = editorInstance.addAction({
    id: 'orca.goToDefinition',
    label: translate('auto.components.editor.MonacoEditor.goToDefinition', 'Go to Definition'),
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 1,
    run: trigger
  })
  const cleanupShortcut = installEditorGoToDefinitionShortcut(editorDomNode, trigger)
  const mouseDownSubscription = editorInstance.onMouseDown((event) => {
    const targetPosition = event.target.position
    if (
      isGoToDefinitionMouseGesture({
        platform: getShortcutPlatform(),
        metaKey: event.event.metaKey,
        ctrlKey: event.event.ctrlKey,
        leftButton: event.event.leftButton,
        contentText: event.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT,
        hasPosition: Boolean(targetPosition)
      }) &&
      targetPosition
    ) {
      editorInstance.setPosition(targetPosition)
      trigger()
    }
  })

  return () => {
    mouseDownSubscription.dispose()
    cleanupShortcut()
    action.dispose()
  }
}
