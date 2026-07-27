import type * as Monaco from 'monaco-editor'
import type { editor, IDisposable } from 'monaco-editor'
import { isMacPlatform } from '../terminal-pane/terminal-link-open-hints'
import {
  ensureImportHoverLinkProvider,
  registerImportHoverContext
} from './monaco-import-hover-link'
import {
  findImportSpecifierLinkAt,
  getImportSpecifierLinks,
  supportsImportSpecifierLinks,
  type ImportSpecifierLink
} from './import-specifier-links'

export type ImportFileLinkDeps = {
  getLanguageId: () => string
  getFilePath: () => string
  getFileId: () => string
  getWorktreeId: () => string | undefined
}

export type ImportFileLinkController = {
  refresh: () => void
  dispose: () => void
}

export const IMPORT_FILE_LINK_REFRESH_DELAY_MS = 120
export const IMPORT_LINKS_MOD_HELD_CLASS = 'monaco-import-links-mod-held'

function isImportLinkActivation(event: {
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}): boolean {
  if (event.altKey || event.shiftKey) {
    return false
  }
  return isMacPlatform() ? event.metaKey : event.ctrlKey
}

export function createImportFileLinkController(
  editorInstance: editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
  deps: ImportFileLinkDeps
): ImportFileLinkController {
  ensureImportHoverLinkProvider(monaco)
  const collection = editorInstance.createDecorationsCollection()
  let links: ImportSpecifierLink[] = []
  let refreshTimer: ReturnType<typeof setTimeout> | null = null

  const modelKey = editorInstance.getModel()?.uri.toString() ?? null
  const unregisterHoverContext = modelKey
    ? registerImportHoverContext(modelKey, {
        getLinks: () => links,
        getSource: () => ({
          filePath: deps.getFilePath(),
          fileId: deps.getFileId(),
          worktreeId: deps.getWorktreeId()
        })
      })
    : null

  const cancelPendingRefresh = (): void => {
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
  }

  const refreshNow = (): void => {
    cancelPendingRefresh()
    const model = editorInstance.getModel()
    if (!model || !supportsImportSpecifierLinks(deps.getLanguageId())) {
      links = []
      collection.clear()
      return
    }
    links = getImportSpecifierLinks(model.getValue())
    collection.set(
      links.map((link) => ({
        range: link.range,
        options: {
          inlineClassName: 'monaco-import-file-link',
          stickiness: 1
        }
      }))
    )
  }

  const refresh = (): void => {
    if (!supportsImportSpecifierLinks(deps.getLanguageId())) {
      refreshNow()
      return
    }
    cancelPendingRefresh()
    // Why: link scans read the full Monaco model; coalescing avoids one scan per keystroke.
    refreshTimer = setTimeout(refreshNow, IMPORT_FILE_LINK_REFRESH_DELAY_MS)
  }

  const contentListener: IDisposable = editorInstance.onDidChangeModelContent(refresh)

  // Why: no preventDefault — the built-in peek must keep opening as before.
  // Triggering showHover on mouseup (after the caret lands on the click point)
  // guarantees the hover card, with our open link, also appears on ctrl+click
  // even when the TS worker cannot resolve a definition and no peek shows.
  const mouseUpListener: IDisposable = editorInstance.onMouseUp((e) => {
    if (
      !e.event.leftButton ||
      !isImportLinkActivation(e.event) ||
      e.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT
    ) {
      return
    }
    const position = e.target.position
    if (!position || !findImportSpecifierLinkAt(links, position)) {
      return
    }
    editorInstance.trigger('orca.importFileLinks', 'editor.action.showHover', undefined)
  })

  refreshNow()

  return {
    refresh,
    dispose: () => {
      cancelPendingRefresh()
      contentListener.dispose()
      mouseUpListener.dispose()
      unregisterHoverContext?.()
      collection.clear()
    }
  }
}
