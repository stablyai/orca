import { useAppStore } from '@/store/index'
import { isTauriNativeHost, invokeNative } from '@/web/tauri-native-host'
import { normalizeDebugPathKey } from '../debug/debug-session-paths'
import type { CodeFileEdits, CodeTextEdit, CodeWorkspaceEdit } from './code-intelligence-types'

function lineColToOffset(text: string, line1: number, col1: number): number {
  const targetLine = Math.max(1, line1)
  const targetCol = Math.max(1, col1) - 1
  let currentLine = 1
  let lineStart = 0
  for (let i = 0; i < text.length && currentLine < targetLine; i += 1) {
    if (text.charCodeAt(i) === 10) {
      currentLine += 1
      lineStart = i + 1
    }
  }
  if (currentLine < targetLine) {
    return text.length
  }
  let lineEnd = lineStart
  while (
    lineEnd < text.length &&
    text.charCodeAt(lineEnd) !== 10 &&
    text.charCodeAt(lineEnd) !== 13
  ) {
    lineEnd += 1
  }
  return Math.min(lineStart + targetCol, lineEnd)
}

/** Apply 1-based UTF-16 text edits sorted bottom-up so earlier replacements never shift later ranges. */
export function applyTextEditsToString(source: string, edits: readonly CodeTextEdit[]): string {
  const sorted = [...edits].sort(
    (a, b) => b.startLine - a.startLine || b.startColumn - a.startColumn
  )
  let next = source
  for (const edit of sorted) {
    const start = lineColToOffset(next, edit.startLine, edit.startColumn)
    const end = Math.max(start, lineColToOffset(next, edit.endLine, edit.endColumn))
    next = next.slice(0, start) + edit.newText + next.slice(end)
  }
  return next
}

/** Rename occurrences of `oldWord` as a whole identifier in `source` (single-file fallback). */
export function replaceWholeWordInString(
  source: string,
  oldWord: string,
  newWord: string
): { text: string; count: number } {
  const escaped = oldWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?<![\\p{L}\\p{N}_$])${escaped}(?![\\p{L}\\p{N}_$])`, 'gu')
  let count = 0
  const text = source.replace(re, () => {
    count += 1
    return newWord
  })
  return { text, count }
}

export async function applyWorkspaceEditInOrca(
  edit: CodeWorkspaceEdit,
  liveBufferReader?: (fileKey: string) => string | null
): Promise<{ filesUpdated: number; editsApplied: number }> {
  const state = useAppStore.getState()
  const openByKey = new Map(
    state.openFiles
      .filter((f) => f.mode === 'edit' && !f.readOnly)
      .map((f) => [normalizeDebugPathKey(f.filePath), f])
  )

  const closedFiles: CodeFileEdits[] = []
  let filesUpdated = 0
  let editsApplied = 0

  for (const fileEdits of edit.files) {
    const key = normalizeDebugPathKey(fileEdits.filePath)
    const openTab = openByKey.get(key)
    if (!openTab) {
      closedFiles.push(fileEdits)
      continue
    }
    let baseText = state.editorDrafts[openTab.id] ?? liveBufferReader?.(key) ?? null
    if (baseText === null && isTauriNativeHost()) {
      const read = await invokeNative<{ content: string; isBinary?: boolean }>('poc_read_file', {
        filePath: openTab.filePath
      }).catch(() => null)
      if (read && !read.isBinary) {
        baseText = read.content
      }
    }
    if (baseText === null) {
      closedFiles.push(fileEdits)
      continue
    }
    const nextText = applyTextEditsToString(baseText, fileEdits.edits)
    if (nextText !== baseText) {
      state.setEditorDraft(openTab.id, nextText)
      state.markFileDirty(openTab.id, true)
      filesUpdated += 1
      editsApplied += fileEdits.edits.length
    }
  }

  if (closedFiles.length > 0 && isTauriNativeHost()) {
    const modified = await invokeNative<string[]>('poc_lsp_apply_workspace_edit', {
      files: closedFiles
    })
    filesUpdated += modified.length
    for (const f of closedFiles) {
      if (modified.includes(f.filePath)) {
        editsApplied += f.edits.length
      }
    }
  }

  return { filesUpdated, editsApplied }
}
