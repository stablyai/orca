import type { TerminalFileLinkActionDeps } from './terminal-file-link-actions'
import { openDetectedFilePath } from './terminal-file-open-routing'
import {
  getTerminalFileContext,
  mapTerminalFilePath,
  shouldOpenTerminalFileWithSystemDefault,
  terminalLinkWslDistro
} from '../../host-files/terminal-file-path-mapping'
import { isMissingRuntimePathError } from '@/runtime/files/metadata/runtime-file-metadata-client'
import { statUserOpenedPath } from '@/lib/user-opened-local-path'
import { beginLinkOpenRequest } from '@/lib/link-open-request'
import { openDocumentInFloatingWorkspace } from '@/lib/open-document-in-floating-workspace'
import { revealFloatingWorkspacePanel } from '@/lib/floating-workspace-panel-reveal'
import { detectLanguage } from '@/lib/language-detect'
import { scheduleEditorLineReveal } from '@/store/slices/editor/focus/editor-focus-reveal'
import { useAppStore } from '@/store/index'

export function openDetectedFileInFloatingWorkspace(
  filePath: string,
  line: number | null,
  column: number | null,
  deps: TerminalFileLinkActionDeps
): void {
  const fileContext = getTerminalFileContext(
    deps.worktreeId,
    deps.worktreePath,
    deps.runtimeEnvironmentId
  )
  // Why: the Floating Workspace only opens this computer's files; remote links keep the normal open.
  if (deps.hostFileOnly || !shouldOpenTerminalFileWithSystemDefault(fileContext)) {
    openDetectedFilePath(filePath, line, column, deps)
    return
  }
  const mappedPath = mapTerminalFilePath(
    filePath,
    deps.worktreePath,
    terminalLinkWslDistro(deps.wslDistro, deps.runtimeEnvironmentId)
  )
  const isCurrentRequest = beginLinkOpenRequest()
  void statUserOpenedPath(fileContext, mappedPath).then(
    (stat) => {
      if (!isCurrentRequest()) {
        return
      }
      if (stat.isDirectory) {
        openDetectedFilePath(filePath, line, column, deps)
        return
      }
      const store = useAppStore.getState()
      const fileId = openDocumentInFloatingWorkspace(store.openFile, {
        filePath: mappedPath,
        relativePath: mappedPath
      })
      revealFloatingWorkspacePanel(store)
      if (line === null) {
        return
      }
      if (detectLanguage(mappedPath) === 'markdown') {
        // Why: rich Markdown has no line-based reveal consumer; line links must mount Monaco.
        store.setMarkdownViewMode(fileId, 'source')
      }
      scheduleEditorLineReveal(useAppStore.getState, mappedPath, line, column ?? 1, fileId, {
        canApply: isCurrentRequest
      })
    },
    (error: unknown) => {
      if (isCurrentRequest()) {
        deps.onOpenFailure?.({
          verdict: isMissingRuntimePathError(error) ? 'missing' : 'unverifiable',
          error
        })
      }
    }
  )
}
