import type { ActivePluginCustomEditor } from '@/store/plugins/file-editors/plugin-custom-editors'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { matchPluginFile } from '../../../../../shared/plugins/contributions/plugin-file-match'
import type { DiffContent, FileContent } from '../editor-panel-content-types'

export function customEditorsForEditTab(
  editors: readonly ActivePluginCustomEditor[],
  activeFile: OpenFile,
  fileContent: FileContent | undefined,
  rawReadOnly: boolean
): readonly ActivePluginCustomEditor[] {
  const contentReady =
    fileContent !== undefined &&
    !fileContent.loadError &&
    fileContent.csvPreview === undefined &&
    activeFile.conflict === undefined
  // Read-only tabs keep raw source, as for every other rich view.
  const textEditorEligible = contentReady && !rawReadOnly && fileContent.isBinary !== true
  // Bytes editors honor read-only themselves, so they open read-only tabs too; they need a pageable route.
  const bytesEditorEligible = contentReady && fileContent.byteSource !== undefined
  return editors.filter((editor) =>
    editor.contentKind === 'bytes' ? bytesEditorEligible : textEditorEligible
  )
}

/** Only offered: Orca's diff stays the default, since its review controls need it. */
export function customEditorsForDiffTab(
  editors: readonly ActivePluginCustomEditor[],
  activeFile: OpenFile,
  diffContent: DiffContent | undefined
): readonly ActivePluginCustomEditor[] {
  if (!diffContent || !isWholeTextDiff(diffContent) || !isReadForTab(diffContent, activeFile)) {
    return []
  }
  return editors
    .filter(
      (editor) =>
        editor.diff === true &&
        editor.contentKind !== 'bytes' &&
        opensOldPath(editor, activeFile.branchOldPath)
    )
    .map((editor) => ({ ...editor, priority: 'option' as const }))
}

function isWholeTextDiff(diffContent: DiffContent): boolean {
  return (
    diffContent.kind === 'text' &&
    diffContent.loadFailed !== true &&
    diffContent.largeDiffRenderLimit?.limited !== true
  )
}

/** Why: a cached diff outlives a rename that went away, and its original side is the old file. */
function isReadForTab(diffContent: DiffContent, activeFile: OpenFile): boolean {
  return diffContent.readWithOldPath === activeFile.branchOldPath
}

/** Why: a rename's original side is another file, which the editor must open too. */
function opensOldPath(editor: ActivePluginCustomEditor, oldPath: string | undefined): boolean {
  return oldPath === undefined || matchPluginFile(oldPath, editor) !== null
}
