import type { OpenFile } from '../types/open-file'

/** The tab-bar label the window's open gives an editor tab for its file. */
export function editorTabLabelOf(file: Pick<OpenFile, 'mode' | 'relativePath'>): string {
  return file.mode === 'markdown-preview' ? `${file.relativePath} (preview)` : file.relativePath
}
