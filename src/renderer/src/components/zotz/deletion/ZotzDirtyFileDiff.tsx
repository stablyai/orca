import React, { useEffect, useState } from 'react'
import { structuredPatch } from 'diff'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store/index'
import { getEditorFileReadContext } from '@/lib/editor/file-operations/editor-file-operation-owner'
import { getRuntimeGitDiff } from '@/runtime/source-control/git/runtime-git-diff-client'
import type { GitDiffResult } from '../../../../../shared/git/diff/git-diff-compare-types'

// A deletion review needs the gist, not the whole file; long diffs stay readable in Source Control.
const MAX_DIFF_LINES = 200

type DiffState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'loaded'; result: GitDiffResult }

export type ZotzDirtyFileOwner = { id: string; path: string }

/** Loads one changed file's diff against HEAD through the worktree's own runtime (local, SSH or WSL). */
function useDirtyFileDiff(owner: ZotzDirtyFileOwner, filePath: string): DiffState {
  const [state, setState] = useState<DiffState>({ kind: 'loading' })
  useEffect(() => {
    let cancelled = false
    const context = getEditorFileReadContext(
      useAppStore.getState(),
      { worktreeId: owner.id },
      owner.path
    )
    void getRuntimeGitDiff(
      {
        target: context.target,
        worktreeId: owner.id,
        worktreePath: owner.path,
        connectionId: context.connectionId
      },
      { filePath, staged: false, compareAgainstHead: true }
    ).then(
      (result) => {
        if (!cancelled) {
          setState({ kind: 'loaded', result })
        }
      },
      () => {
        if (!cancelled) {
          setState({ kind: 'failed' })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [owner.id, owner.path, filePath])
  return state
}

function diffLines(filePath: string, original: string, modified: string): string[] {
  const patch = structuredPatch(filePath, filePath, original, modified, '', '', { context: 2 })
  return patch.hunks.flatMap((hunk) => [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...hunk.lines
  ])
}

/** Inline unified diff for a file a delete would lose. */
export function ZotzDirtyFileDiff({
  owner,
  filePath
}: {
  owner: ZotzDirtyFileOwner
  filePath: string
}): React.JSX.Element {
  const t = useTranslate()
  const state = useDirtyFileDiff(owner, filePath)
  if (state.kind !== 'loaded') {
    return (
      <p className="py-1 text-muted-foreground">
        {state.kind === 'loading'
          ? t('zotz.deleteReview.loading', 'Loading changes…')
          : t('zotz.deleteReview.failed', 'Could not load the changes')}
      </p>
    )
  }
  if (state.result.kind === 'binary') {
    return (
      <p className="py-1 text-muted-foreground">
        {t('zotz.deleteReview.binary', 'Binary file; compare it in Source Control')}
      </p>
    )
  }
  const lines = diffLines(filePath, state.result.originalContent, state.result.modifiedContent)
  if (lines.length === 0) {
    return (
      <p className="py-1 text-muted-foreground">
        {t('zotz.deleteReview.noTextChanges', 'No text changes')}
      </p>
    )
  }
  // A diff is a fixed sequence, so its line number is a stable identity.
  const shown = lines.slice(0, MAX_DIFF_LINES).map((text, lineNumber) => ({ text, lineNumber }))
  return (
    <div className="scrollbar-sleek mt-1 max-h-60 overflow-auto rounded-sm border border-border bg-muted/40 py-1 font-mono text-xs leading-4">
      {shown.map(({ text: line, lineNumber }) => (
        <div
          key={lineNumber}
          className={cn(
            'whitespace-pre px-2',
            line.startsWith('+') && 'text-chat-diff-added',
            line.startsWith('-') && 'text-chat-diff-removed',
            line.startsWith('@@') && 'text-muted-foreground'
          )}
        >
          {line}
        </div>
      ))}
      {lines.length > shown.length ? (
        <div className="px-2 text-muted-foreground">
          {t('zotz.deleteReview.truncated', '… {{count}} more lines', {
            count: lines.length - shown.length,
            defaultValue_one: '… {{count}} more line'
          })}
        </div>
      ) : null}
    </div>
  )
}

/** A changed path that expands to its diff; without an owner it stays the plain upstream row. */
export function ZotzDirtyFileToggle({
  owner,
  filePath,
  children
}: {
  owner: ZotzDirtyFileOwner | undefined
  filePath: string
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  if (!owner) {
    return <>{children}</>
  }
  return (
    <div className="min-w-0 flex-1">
      <button
        type="button"
        aria-expanded={open}
        title={t('zotz.deleteReview.showDiff', 'Show changes')}
        onClick={() => setOpen(!open)}
        className="w-full min-w-0 cursor-pointer text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {children}
      </button>
      {open ? <ZotzDirtyFileDiff owner={owner} filePath={filePath} /> : null}
    </div>
  )
}
