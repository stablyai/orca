import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import type { editor } from 'monaco-editor'
import type { GitBlameResult } from '../../../../shared/git-blame'
import { useAppStore } from '@/store'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { formatPrCommentRelativeTime } from '@/lib/pr-comment-time'
import { getRuntimeGitBlame } from '@/runtime/runtime-git-client'
import { findWorktreeById } from '@/store/slices/worktree-helpers'

const blameCache = new Map<string, Promise<GitBlameResult>>()

function blameLabel(author: string, authorTime: number, summary: string): string {
  const relativeTime = formatPrCommentRelativeTime(
    new Date(authorTime * 1000).toISOString(),
    Date.now()
  )
  return [author, relativeTime, summary].filter(Boolean).join(' · ')
}

type UseGitBlameProps = {
  editor: editor.IStandaloneCodeEditor | null
  worktreeId?: string
  filePath: string
  enabled: boolean
}

export function useGitBlame({ editor, worktreeId, filePath, enabled }: UseGitBlameProps): void {
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const cacheKey = worktreeId && filePath ? `${worktreeId}:${filePath}` : null

  useEffect(() => {
    const ed = editor
    if (!ed || !enabledRef.current || !worktreeId || !cacheKey || !filePath) {
      return
    }
    const state = useAppStore.getState()
    const worktree = findWorktreeById(state.worktreesByRepo, worktreeId)
    if (!worktree) {
      return
    }

    let disposed = false
    let latestResult: GitBlameResult | null = null
    const decorations = ed.createDecorationsCollection([])
    const update = (): void => {
      if (disposed) {
        return
      }
      const position = ed.getPosition()
      const info = position ? latestResult?.[position.lineNumber - 1] : null
      if (!position || !info) {
        decorations.clear()
        return
      }
      decorations.set([
        {
          range: {
            startLineNumber: position.lineNumber,
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: ed.getModel()?.getLineMaxColumn(position.lineNumber) ?? 1
          },
          options: {
            after: {
              content: `  ${blameLabel(info.author, info.authorTime, info.summary)}`,
              inlineClassName: 'orca-git-blame'
            },
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
          }
        }
      ])
    }

    update()
    const cursorSub = ed.onDidChangeCursorPosition(update)
    const selectionSub = ed.onDidChangeCursorSelection(update)
    const contentSub = ed.onDidChangeModelContent(update)
    const disposeSub = ed.onDidDispose(() => {
      disposed = true
      decorations.clear()
    })

    const promise =
      blameCache.get(cacheKey) ??
      getRuntimeGitBlame(
        {
          settings: state.settings,
          worktreeId,
          worktreePath: worktree.path,
          connectionId: getConnectionIdForFile(worktreeId, filePath) ?? undefined
        },
        filePath
      )
    blameCache.set(cacheKey, promise)
    void promise
      .then((result) => {
        if (disposed) {
          return
        }
        latestResult = result
        update()
      })
      .catch(() => {
        if (!disposed) {
          blameCache.delete(cacheKey)
          latestResult = []
          update()
        }
      })

    return () => {
      disposed = true
      cursorSub.dispose()
      selectionSub.dispose()
      contentSub.dispose()
      disposeSub.dispose()
      decorations.clear()
    }
  }, [cacheKey, editor, filePath, worktreeId])
}
