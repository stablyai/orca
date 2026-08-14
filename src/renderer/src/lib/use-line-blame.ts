import React from 'react'
import { useAppStore } from '@/store'
import { resolveBlameTarget } from '@/lib/blame-target'
import {
  BLAME_DEBOUNCE_MS,
  blameKey,
  cachedLineBlame,
  CACHE_TTL_MS,
  clearLineBlameCache,
  requestLineBlame,
  subscribeToLineBlame,
  type BlameAnswer,
  type BlameTarget
} from '@/lib/line-blame-request'
import type { GitLineBlameResult } from '../../../shared/git-line-blame-types'

/**
 * Authorship for the line under the cursor of the active file, or null when
 * there is nothing to show.
 *
 * Shared by the status-bar segment and the inline editor annotation; the request
 * pump behind it is module-scoped, so both surfaces answer from one git blame.
 */
export function useLineBlame(enabled: boolean): {
  blame: GitLineBlameResult | null
  line: number | null
} {
  const activeFileId = useAppStore((s) => s.activeFileId)
  const cursorLine = useAppStore((s) =>
    activeFileId ? s.editorCursorLine[activeFileId] : undefined
  )
  const activeFile = useAppStore((s) =>
    activeFileId ? s.openFiles.find((file) => file.id === activeFileId) : undefined
  )
  const [answer, setAnswer] = React.useState<BlameAnswer | null>(null)
  // Bumped when a displayed answer expires, so the request effect re-runs for a
  // key that has not otherwise changed.
  const [revalidation, setRevalidation] = React.useState(0)

  const worktreeId = activeFile?.worktreeId
  const filePath = activeFile?.filePath
  const workspaceRelativePath = activeFile?.relativePath
  const runtimeEnvironmentId = activeFile?.runtimeEnvironmentId ?? null
  // Why: while the buffer has unsaved edits its line numbers drift from the
  // on-disk file git blames, so blaming the cursor line would name the wrong
  // commit — hide until the file is saved.
  const isDirty = activeFile?.isDirty ?? false

  // Why one selector, and why it checks `enabled` first: zustand re-runs every
  // subscribed selector on every store write, and `setEditorCursorLine` writes on
  // each cursor move. Resolving the owning repo is not free — for a folder
  // workspace it walks project groups and every candidate repo — so a read-only
  // editor or a disabled setting must not pay for it at all.
  const wanted = enabled && !isDirty && Boolean(filePath && workspaceRelativePath && cursorLine)
  const rootPath = useAppStore((s) =>
    wanted && filePath && workspaceRelativePath
      ? (resolveBlameTarget(s, worktreeId, filePath, workspaceRelativePath)?.rootPath ?? null)
      : null
  )
  const relativePath = useAppStore((s) =>
    wanted && filePath && workspaceRelativePath
      ? (resolveBlameTarget(s, worktreeId, filePath, workspaceRelativePath)?.relativePath ?? null)
      : null
  )

  const target: BlameTarget | null =
    wanted && worktreeId && filePath && relativePath && rootPath && cursorLine
      ? {
          worktreeId,
          filePath,
          relativePath,
          worktreePath: rootPath,
          runtimeEnvironmentId,
          line: cursorLine
        }
      : null
  const currentKey = target ? blameKey(target) : null

  // Why: cached authorship is only valid for the file it was read from, and an
  // edit re-maps every line, so drop it when either changes.
  React.useEffect(() => {
    clearLineBlameCache()
    setAnswer(null)
  }, [worktreeId, workspaceRelativePath, isDirty])

  React.useEffect(() => subscribeToLineBlame(setAnswer), [])

  React.useEffect(() => {
    if (!target || !currentKey) {
      return
    }
    const cached = cachedLineBlame(currentKey)
    if (cached) {
      // Why: a line already read this session paints immediately, so revisiting
      // it doesn't blink through empty and doesn't respawn git.
      setAnswer({ key: currentKey, result: cached, readAt: Date.now() })
      return
    }
    const timer = setTimeout(() => requestLineBlame(target), BLAME_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
    }
    // Why keyed on the request identity: the target object is rebuilt every
    // render, but only a change of identity should restart the debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, revalidation])

  // Why an expiry timer rather than relying on the cache check: once an answer
  // is in component state it is returned on key equality alone, so a cursor that
  // never moves would keep showing authorship from a revision an outside commit
  // has already replaced. Re-request when the window closes.
  React.useEffect(() => {
    if (!answer || !currentKey || answer.key !== currentKey) {
      return
    }
    const expire = (): void => {
      setAnswer(null)
      setRevalidation((tick) => tick + 1)
    }
    const remaining = answer.readAt + CACHE_TTL_MS - Date.now()
    if (remaining <= 0) {
      expire()
      return
    }
    const timer = setTimeout(expire, remaining)
    return () => {
      clearTimeout(timer)
    }
  }, [answer, currentKey])

  // Why compare keys during render: never hand back an answer for a line the
  // cursor has left, or the caller would anchor it to the current line and
  // misattribute it.
  const matches = answer !== null && currentKey !== null && answer.key === currentKey
  return { blame: matches ? answer.result : null, line: matches ? (cursorLine ?? null) : null }
}
