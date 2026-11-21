import { scheduleEditorLineReveal } from '@/store/slices/editor/focus/editor-focus-reveal'
import { useAppStore } from '@/store/index'
import { detectLanguage } from '../../../../../../shared/editor-language/editor-language-detect'
import { relativePathInsideRoot } from '../../../../../../shared/file-access/cross-platform-path'
import type { ImportNavigationSource } from './import-navigation-source'

/** Open an import target in the same workspace and host as the file that imports it. */
export function openImportTarget(
  source: ImportNavigationSource,
  filePath: string,
  line: number,
  column: number
): boolean {
  const relativePath = relativePathInsideRoot(source.worktreePath, filePath)
  const store = useAppStore.getState()
  // Why re-check: the jump was resolved earlier; never open it under an owner that has since changed.
  if (relativePath === null || !source.isCurrent(store)) {
    return false
  }
  const language = detectLanguage(filePath)
  const fileId = store.openFile({
    filePath,
    relativePath,
    worktreeId: source.file.worktreeId,
    runtimeEnvironmentId: source.file.runtimeEnvironmentId,
    externalSshTargetId: source.file.externalSshTargetId,
    operationProvenance: source.file.operationProvenance,
    language,
    mode: 'edit'
  })
  if (language === 'markdown') {
    // A line target only exists in the source view.
    store.setMarkdownViewMode(fileId, 'source')
  }
  scheduleEditorLineReveal(useAppStore.getState, filePath, line, column, fileId)
  return true
}
