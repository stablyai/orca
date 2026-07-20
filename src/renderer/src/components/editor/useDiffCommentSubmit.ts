// Why: handles diff comment submission for both local diff comments and external
// line comment handlers. Extracted to reduce DiffViewer.tsx line count.
import type { DiffComment } from '../../../../shared/types'

export function useDiffCommentSubmit({
  popover,
  onAddLineComment,
  worktreeId,
  relativePath,
  addDiffComment,
  setPopover
}: {
  popover: {
    lineNumber: number
    startLine?: number
    top: number
    left?: number
    lineHeight: number
  } | null
  onAddLineComment:
    | ((props: { lineNumber: number; startLine?: number; body: string }) => Promise<boolean>)
    | undefined
  worktreeId: string | undefined
  relativePath: string
  addDiffComment: (props: {
    worktreeId: string
    filePath: string
    source: 'diff' | 'markdown'
    startLine?: number
    lineNumber: number
    body: string
    side: 'modified'
  }) => Promise<DiffComment | null>
  setPopover: React.Dispatch<
    React.SetStateAction<{
      lineNumber: number
      startLine?: number
      top: number
      left?: number
      lineHeight: number
    } | null>
  >
}): (body: string) => Promise<void> {
  return async (body: string): Promise<void> => {
    if (!popover) {
      return
    }
    if (onAddLineComment) {
      const ok = await onAddLineComment({
        lineNumber: popover.lineNumber,
        startLine: popover.startLine,
        body
      })
      if (ok) {
        setPopover(null)
      }
      return
    }
    if (!worktreeId) {
      return
    }
    // Why: await persistence before closing — if addDiffComment resolves null
    // (store rolled back after IPC failure), keep the popover open so the user
    // can retry instead of silently losing their draft.
    const result = await addDiffComment({
      worktreeId,
      filePath: relativePath,
      source: 'diff',
      startLine: popover.startLine,
      lineNumber: popover.lineNumber,
      body,
      side: 'modified' as const
    })
    if (result) {
      setPopover(null)
    } else {
      console.error('Failed to add diff comment — draft preserved')
    }
  }
}
