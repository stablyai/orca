import { detectLanguage } from '../../../../../shared/editor-language/editor-language-detect'
import { canPreviewLanguage } from '@/lib/browser/documents/file-preview'
import type { Translate } from '@/i18n/use-translate'

/** How an editor surface previews a changed file, by editor language: a page, rendered Markdown, or neither. */
export type ChangedFileView = 'page' | 'markdown' | 'source'

/** Where an explicit open action puts a changed file; each destination has one name and icon on every surface. */
export type ChangedFileOpenTarget = 'orca-browser' | 'markdown-preview' | 'editor'

export function editorChangedFileView(path: string): ChangedFileView {
  const language = detectLanguage(path)
  if (canPreviewLanguage(language)) {
    return 'page'
  }
  return language === 'markdown' ? 'markdown' : 'source'
}

export function changedFileOpenLabel(
  target: ChangedFileOpenTarget,
  t: Translate,
  placement: 'tab' | 'side' = 'tab'
): string {
  if (target === 'orca-browser') {
    return placement === 'side'
      ? t('files.changedFile.openInOrcaBrowserToSide', 'Open in Orca Browser to the Side')
      : t('auto.components.right.sidebar.FileExplorerRow.dd112c81d2', 'Open in Orca Browser')
  }
  if (target === 'markdown-preview') {
    return placement === 'side'
      ? t('files.changedFile.openMarkdownPreviewToSide', 'Open Markdown Preview to the Side')
      : t('auto.components.right.sidebar.FileExplorerRow.d87a4c42e1', 'Open Markdown Preview')
  }
  return t('auto.components.editor.EditorPanelHeader.a10d9b8337', 'Open file')
}
