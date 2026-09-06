import { useCallback } from 'react'
import type { Editor } from '@tiptap/react'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { TerminalTargetShell } from './terminal-drop-shell'
import {
  dispatchTerminalRichInputDroppedPaths,
  insertTerminalRichInputFilePaths
} from './terminal-rich-input-dropped-paths'
import type { TerminalRichInputResourceContext } from './terminal-rich-input-model'

export function useTerminalRichInputPathInsertion({
  editor,
  agent,
  resourceContext,
  targetShell,
  sending,
  canAttachImages,
  appendImagePaths
}: {
  editor: Editor | null
  agent: AgentType | null
  resourceContext: TerminalRichInputResourceContext
  targetShell: TerminalTargetShell
  sending: boolean
  canAttachImages: boolean
  appendImagePaths: (paths: string[], insertionPosition?: number) => void
}): (paths: string[]) => void {
  const insertFilePaths = useCallback(
    (paths: string[]) =>
      insertTerminalRichInputFilePaths(editor, paths, Boolean(agent), resourceContext, targetShell),
    [agent, editor, resourceContext, targetShell]
  )

  return useCallback(
    (paths: string[]) => {
      if (sending) {
        return
      }
      dispatchTerminalRichInputDroppedPaths({
        paths,
        canAttachImages,
        insertImagePath: (path) => appendImagePaths([path], editor?.state.selection.from),
        insertFilePath: (path) => insertFilePaths([path])
      })
    },
    [appendImagePaths, canAttachImages, editor, insertFilePaths, sending]
  )
}
