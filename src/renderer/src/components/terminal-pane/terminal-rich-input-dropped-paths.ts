import type { Editor } from '@tiptap/react'
import { isImageDropPath } from './terminal-drop-image-path'
import type { TerminalTargetShell } from './terminal-drop-shell'
import {
  terminalRichInputPathsToContent,
  type TerminalRichInputResourceContext
} from './terminal-rich-input-model'

export function insertTerminalRichInputFilePaths(
  editor: Editor | null,
  paths: string[],
  useMentions: boolean,
  context: TerminalRichInputResourceContext,
  targetShell: TerminalTargetShell
): void {
  if (!editor || paths.length === 0) {
    return
  }
  editor
    .chain()
    .focus()
    .insertContent(terminalRichInputPathsToContent(paths, useMentions, context, targetShell))
    .run()
}

export function dispatchTerminalRichInputDroppedPaths({
  paths,
  canAttachImages,
  insertImagePath,
  insertFilePath
}: {
  paths: readonly string[]
  canAttachImages: boolean
  insertImagePath: (path: string) => void
  insertFilePath: (path: string) => void
}): void {
  for (const path of paths) {
    if (canAttachImages && isImageDropPath(path)) {
      insertImagePath(path)
    } else {
      insertFilePath(path)
    }
  }
}
