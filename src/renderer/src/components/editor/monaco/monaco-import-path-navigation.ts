import type { editor, IPosition } from 'monaco-editor'
import type { MutableRefObject } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getConnectionIdForFile } from '@/lib/workspace/ownership/connection-context'
import { getRuntimeTargetForFileOwner } from '@/lib/files/access/file-owner-runtime-target'
import { statRuntimePath } from '@/runtime/files/metadata/runtime-file-metadata-client'
import { readRuntimeFileContent } from '@/runtime/files/reads/runtime-file-read-client'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { getRelativePathInsideRoot } from '@/lib/path'
import { isMacPlatform } from '@/components/terminal-pane/links/terminal-link-open-hints'
import { detectLanguage } from '../../../../../shared/editor-language/editor-language-detect'
import {
  configSearchDirectories,
  findImportSpecifierAt,
  importCandidatePaths,
  parseModuleResolutionConfig,
  resolvePath,
  type ImportSpecifierHit,
  type ModuleResolutionConfig
} from '@/lib/editor/import-navigation/import-specifier-resolution'

const IMPORT_NAVIGATION_LANGUAGES = new Set(['typescript', 'javascript'])
const CONFIG_FILE_NAMES = ['tsconfig.json', 'jsconfig.json']

type ImportNavigationParams = {
  editorInstance: editor.ICodeEditor
  worktreeId: string | undefined
  /** Absolute, or relative to the worktree root (combined-diff sections). */
  filePath: string
  fileIdRef?: MutableRefObject<string>
}

async function openImportTarget(
  specifier: string,
  { filePath: sourcePath, worktreeId, fileIdRef }: Omit<ImportNavigationParams, 'editorInstance'>
): Promise<void> {
  const state = useAppStore.getState()
  const worktree = worktreeId ? findWorktreeById(state, worktreeId) : null
  if (!worktreeId || !worktree) {
    return
  }
  const filePath = /^([A-Za-z]:)?[\\/]/.test(sourcePath)
    ? sourcePath
    : resolvePath(worktree.path, sourcePath)
  const runtimeEnvironmentId = state.openFiles.find((file) =>
    fileIdRef ? file.id === fileIdRef.current : file.filePath === filePath
  )?.runtimeEnvironmentId
  const target = getRuntimeTargetForFileOwner(state, worktreeId, runtimeEnvironmentId)
  const connectionId = getConnectionIdForFile(worktreeId, filePath)
  if (!target || connectionId === undefined) {
    return
  }
  const context = {
    target,
    worktreeId,
    worktreePath: worktree.path,
    connectionId: connectionId ?? undefined
  }

  let config: ModuleResolutionConfig | null = null
  if (!specifier.startsWith('.')) {
    search: for (const directory of configSearchDirectories(filePath, worktree.path)) {
      for (const name of CONFIG_FILE_NAMES) {
        const configPath = resolvePath(directory, name)
        try {
          const { content, isBinary } = await readRuntimeFileContent({
            target,
            filePath: configPath,
            relativePath: getRelativePathInsideRoot(configPath, worktree.path) ?? undefined,
            worktreeId,
            connectionId: connectionId ?? undefined
          })
          config = isBinary ? null : parseModuleResolutionConfig(content, directory)
          break search
        } catch {
          continue
        }
      }
    }
  }

  for (const candidate of importCandidatePaths(specifier, filePath, config)) {
    const relativePath = getRelativePathInsideRoot(candidate, worktree.path)
    if (relativePath === null) {
      continue
    }
    try {
      const stats = await statRuntimePath(context, candidate)
      if (stats.isDirectory) {
        continue
      }
    } catch {
      continue
    }
    useAppStore.getState().openFile({
      filePath: candidate,
      relativePath,
      worktreeId,
      runtimeEnvironmentId,
      language: detectLanguage(candidate),
      mode: 'edit'
    })
    return
  }
  toast.error(
    translate(
      'auto.components.editor.importPathNavigation.notFound',
      "Cannot find a file for '{{value0}}'",
      { value0: specifier }
    )
  )
}

/** Cmd/Ctrl+click on an import's module path opens the file it resolves to; Cmd/Ctrl+hover marks it as a link. */
export function installMonacoImportPathNavigation({
  editorInstance,
  ...params
}: ImportNavigationParams): { dispose: () => void } {
  const isModifierKey = (key: string): boolean => key === (isMacPlatform() ? 'Meta' : 'Control')
  const hasModifier = (event: { metaKey: boolean; ctrlKey: boolean }): boolean =>
    isMacPlatform() ? event.metaKey : event.ctrlKey
  // Why: Monaco's own go-to-definition class gives VS Code's underline, link color and pointer cursor.
  const linkDecoration = editorInstance.createDecorationsCollection()
  let hoverPosition: IPosition | null = null

  const hitAt = (position: IPosition | null): ImportSpecifierHit | null => {
    const model = editorInstance.getModel()
    if (!model || !position || !IMPORT_NAVIGATION_LANGUAGES.has(model.getLanguageId())) {
      return null
    }
    return findImportSpecifierAt(model.getLineContent(position.lineNumber), position.column)
  }

  const showLink = (active: boolean): void => {
    const hit = active ? hitAt(hoverPosition) : null
    if (!hit || !hoverPosition) {
      linkDecoration.clear()
      return
    }
    linkDecoration.set([
      {
        range: {
          startLineNumber: hoverPosition.lineNumber,
          startColumn: hit.startColumn,
          endLineNumber: hoverPosition.lineNumber,
          endColumn: hit.endColumn + 1
        },
        options: { inlineClassName: 'goto-definition-link' }
      }
    ])
  }

  const subscriptions = [
    editorInstance.onMouseMove((e) => {
      hoverPosition = e.target.position
      showLink(hasModifier(e.event))
    }),
    editorInstance.onMouseLeave(() => {
      hoverPosition = null
      linkDecoration.clear()
    }),
    editorInstance.onKeyDown((e) => {
      if (isModifierKey(e.browserEvent.key)) {
        showLink(true)
      }
    }),
    editorInstance.onKeyUp((e) => {
      if (isModifierKey(e.browserEvent.key)) {
        linkDecoration.clear()
      }
    }),
    editorInstance.onDidBlurEditorWidget(() => linkDecoration.clear()),
    editorInstance.onMouseDown((e) => {
      const hit = hasModifier(e.event) && e.event.leftButton ? hitAt(e.target.position) : null
      if (!hit) {
        return
      }
      e.event.preventDefault()
      e.event.stopPropagation()
      linkDecoration.clear()
      void openImportTarget(hit.specifier, params)
    })
  ]

  return {
    dispose: () => {
      for (const subscription of subscriptions) {
        subscription.dispose()
      }
      linkDecoration.clear()
    }
  }
}

/** Import navigation on both panes of a diff, disposed with the diff. */
export function installDiffImportPathNavigation(
  diffEditor: editor.IStandaloneDiffEditor,
  params: Omit<ImportNavigationParams, 'editorInstance' | 'fileIdRef'>
): void {
  const modifiedEditor = diffEditor.getModifiedEditor()
  const subscriptions = [diffEditor.getOriginalEditor(), modifiedEditor].map((editorInstance) =>
    installMonacoImportPathNavigation({ editorInstance, ...params })
  )
  modifiedEditor.onDidDispose(() => {
    for (const subscription of subscriptions) {
      subscription.dispose()
    }
  })
}
