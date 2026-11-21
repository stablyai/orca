import { useLayoutEffect, useRef, type MutableRefObject } from 'react'
import type { Editor } from '@tiptap/react'
import { getRelativePathInsideRoot } from '@/lib/path'
import { addQuoteToLastUsedAgent } from '../../../native-chat/selection-quotes/add-quote-to-last-used-agent'
import { richMarkdownSelectionAgentQuote } from './rich-markdown-selection-agent-quote'

/** The editor.addSelectionToLastAgent action, kept current for ProseMirror's retained key handler. */
export function useRichMarkdownAddSelectionToLastAgent(owner: {
  editorRef: MutableRefObject<Editor | null>
  worktreeId: string
  filePath: string
  worktreeRoot: string | null
  markdownSourceLineOffsetRef: MutableRefObject<number>
}): MutableRefObject<() => boolean> {
  const { editorRef, worktreeId, filePath, worktreeRoot, markdownSourceLineOffsetRef } = owner
  const actionRef = useRef<() => boolean>(() => false)
  useLayoutEffect(() => {
    actionRef.current = () => {
      const editor = editorRef.current
      const relativePath = getRelativePathInsideRoot(filePath, worktreeRoot) ?? filePath
      const quote =
        editor &&
        richMarkdownSelectionAgentQuote(editor, relativePath, markdownSourceLineOffsetRef.current)
      if (!quote) {
        return false
      }
      // Consumed even with no agent so the chord never edits the selection.
      addQuoteToLastUsedAgent(worktreeId, quote)
      return true
    }
  }, [editorRef, worktreeId, filePath, worktreeRoot, markdownSourceLineOffsetRef])
  return actionRef
}
