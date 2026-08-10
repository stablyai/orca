import React, { useEffect, useState } from 'react'
import { History } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAppStore } from '@/store'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { formatPrCommentRelativeTime } from '@/lib/pr-comment-time'
import { getRuntimeGitHistory } from '@/runtime/runtime-git-client'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { translate } from '@/i18n/i18n'
import type { GitHistoryItem } from '../../../../shared/git-history'

type GitFileHistoryDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  relativePath: string
  filePath: string
  worktreeId?: string
}

type FileHistoryState =
  | { status: 'idle' | 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; items: GitHistoryItem[] }

function formatRelativeTimestamp(timestamp: number | undefined): string {
  if (!timestamp || !Number.isFinite(timestamp)) {
    return ''
  }
  return formatPrCommentRelativeTime(new Date(timestamp).toISOString(), Date.now())
}

/** Keeps the dialog target stable when the active worktree changes. */
export function GitFileHistoryDialog({
  open,
  onOpenChange,
  title,
  relativePath,
  filePath,
  worktreeId
}: GitFileHistoryDialogProps): React.JSX.Element {
  const [state, setState] = useState<FileHistoryState>({ status: 'idle' })

  useEffect(() => {
    if (!open || !worktreeId || !relativePath) {
      setState({ status: 'idle' })
      return
    }
    let cancelled = false
    const store = useAppStore.getState()
    const worktree = findWorktreeById(store.worktreesByRepo, worktreeId)
    if (!worktree) {
      setState({
        status: 'error',
        error: translate(
          'auto.components.editor.GitFileHistoryDialog.13bbd3745e',
          'Workspace is not available yet.'
        )
      })
      return
    }

    setState({ status: 'loading' })
    getRuntimeGitHistory(
      {
        settings: store.settings,
        worktreeId,
        worktreePath: worktree.path,
        connectionId: getConnectionIdForFile(worktreeId, filePath) ?? undefined
      },
      { limit: 50, filePath: relativePath }
    )
      .then((result) => {
        if (!cancelled) {
          setState({ status: 'ready', items: result.items })
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            error:
              error instanceof Error
                ? error.message
                : translate(
                    'auto.components.editor.GitFileHistoryDialog.565f664463',
                    'Failed to load git history.'
                  )
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [filePath, open, relativePath, worktreeId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.editor.GitFileHistoryDialog.399ece93d0', 'Git History')}
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 truncate text-xs text-muted-foreground">{title}</div>
        {state.status === 'loading' && (
          <div className="py-6 text-center text-xs text-muted-foreground">
            {translate(
              'auto.components.editor.GitFileHistoryDialog.7f49174c71',
              'Loading history…'
            )}
          </div>
        )}
        {state.status === 'error' && (
          <div className="py-6 text-center text-xs text-destructive">{state.error}</div>
        )}
        {state.status === 'ready' && state.items.length === 0 && (
          <div className="py-6 text-center text-xs text-muted-foreground">
            {translate(
              'auto.components.editor.GitFileHistoryDialog.77da374615',
              'No commits found for this file.'
            )}
          </div>
        )}
        {state.status === 'ready' && state.items.length > 0 && (
          <ScrollArea className="max-h-[60vh]">
            <div className="space-y-2 pr-3">
              {state.items.map((item) => (
                <div
                  key={item.id}
                  className="rounded-md border border-border/70 bg-muted/20 px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <History className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {item.displayId ?? item.id.slice(0, 7)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-foreground">{item.subject}</span>
                  </div>
                  <div className="mt-1 pl-6 text-[11px] text-muted-foreground">
                    {[item.author, formatRelativeTimestamp(item.timestamp)]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  )
}
