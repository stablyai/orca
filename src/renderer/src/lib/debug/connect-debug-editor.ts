import type { OnMount } from '@monaco-editor/react'
import type { editor, IDisposable } from 'monaco-editor'
import type { DebugWorktree } from '../../../../preload/api/debug-api'
import { useAppStore } from '@/store'
import { scheduleEditorLineReveal } from '@/store/slices/editor/focus/editor-focus-reveal'
import { detectLanguage } from '@/lib/language-detect'
import { getRelativePathInsideRoot, joinPath } from '@/lib/path'
import { debugClient, type DebugClient } from './debug-client'
import { resolveDebugEditorContext, type DebugEditorContext } from './debug-editor-context'
import { debugSessionStore, type DebugSessionStore } from './use-debug-session'
import { ensureDebugGlyphStyles, installBreakpointDecorations } from './breakpoint-decorations'
import { installBreakpointEditorInput } from './breakpoint-editor-input'
import { installStoppedLocation, type StoppedLocationReveal } from './stopped-location-decorations'
import { ensureDebugHoverProvider, registerDebugHoverModel } from './debug-hover'

export type DebugMonaco = NonNullable<Parameters<OnMount>[1]>

/** One editor's view of its worktree; core reports realpaths, the editor keeps its own spelling. */
export type DebugEditorBinding = {
  /** What every debug:* call sends: main re-derives the root from it. */
  target: DebugWorktree
  filePath: string
  /** Core's realpath of the root, from the first snapshot; null until known. */
  getCoreRoot: () => string | null
  isThisFile: (corePath: string | undefined) => boolean
  toEditorPath: (corePath: string) => string
}

export type DebugEditorDeps = {
  client: DebugClient
  sessionStore: DebugSessionStore
  resolveContext: (worktreeId: string, filePath: string) => DebugEditorContext | null
  reveal: StoppedLocationReveal
}

export function createDebugEditorBinding(
  context: DebugEditorContext,
  coreRoot: () => string | null
): DebugEditorBinding {
  const { repoId, rootPath, filePath } = context
  const relative = getRelativePathInsideRoot(filePath, rootPath)
  return {
    target: { repoId, worktreePath: rootPath },
    filePath,
    getCoreRoot: coreRoot,
    isThisFile: (corePath) => {
      const root = coreRoot()
      return (
        corePath !== undefined &&
        (corePath === filePath ||
          (root !== null && relative !== null && corePath === joinPath(root, relative)))
      )
    },
    toEditorPath: (corePath) => {
      const root = coreRoot()
      const inside = root === null ? null : getRelativePathInsideRoot(corePath, root)
      return inside === null ? corePath : joinPath(rootPath, inside)
    }
  }
}

function defaultDeps(worktreeId: string): DebugEditorDeps {
  return {
    client: debugClient,
    sessionStore: debugSessionStore,
    resolveContext: (id, filePath) =>
      resolveDebugEditorContext(useAppStore.getState(), id, filePath),
    reveal: {
      isOpen: (filePath) => useAppStore.getState().openFiles.some((f) => f.filePath === filePath),
      open: (filePath, rootPath, line, column) => {
        // Debug sessions are local-only (core refuses remote workspaces), so no runtime owner is set.
        const fileId = useAppStore.getState().openFile({
          filePath,
          relativePath: getRelativePathInsideRoot(filePath, rootPath) ?? filePath,
          worktreeId,
          language: detectLanguage(filePath),
          mode: 'edit'
        })
        scheduleEditorLineReveal(useAppStore.getState, filePath, line, column, fileId)
      }
    }
  }
}

/** Installs breakpoints, the stopped line and hover evaluate on one file editor. */
export function connectDebugEditor(
  editorInstance: editor.IStandaloneCodeEditor,
  monaco: DebugMonaco,
  params: { filePath: string; worktreeId: string },
  overrides: Partial<DebugEditorDeps> = {}
): IDisposable {
  const deps = { ...defaultDeps(params.worktreeId), ...overrides }
  const context = deps.resolveContext(params.worktreeId, params.filePath)
  const model = editorInstance.getModel()
  if (!context || !model) {
    return { dispose: () => {} }
  }
  let coreRoot: string | null = null
  let disposed = false
  const binding = createDebugEditorBinding(context, () => coreRoot)
  const { client, sessionStore } = deps

  ensureDebugGlyphStyles()
  // Shared and idempotent: one editor closing must not detach the store from every other reader.
  sessionStore.connect()
  ensureDebugHoverProvider(monaco, model.getLanguageId(), sessionStore, client)
  const breakpoints = installBreakpointDecorations(editorInstance, monaco, binding, deps)
  const stopped = installStoppedLocation(editorInstance, binding, deps)
  const disposables: IDisposable[] = [
    breakpoints,
    stopped,
    installBreakpointEditorInput(editorInstance, monaco, breakpoints),
    registerDebugHoverModel(model.uri.toString(), binding)
  ]

  // The snapshot names core's realpath for this root; pushes are keyed by it.
  void client.snapshot(binding.target).then((result) => {
    if (!disposed && result.ok) {
      coreRoot = result.value.worktreePath
      sessionStore.ingestSnapshot(result.value)
      breakpoints.refresh()
      stopped.update()
    }
  })

  return {
    dispose: () => {
      if (disposed) {
        return
      }
      disposed = true
      disposables.forEach((disposable) => disposable.dispose())
    }
  }
}
