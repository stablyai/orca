import { useMemo, useState } from 'react'
import { Trash2, MessageSquare, FileCode, Play, Clipboard } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { OpenFile } from '@/store/slices/editor'
import type { DiffComment } from '../../../../shared/types'
import { formatDiffComments } from '@/lib/diff-comments-format'
import { DiffCommentsAgentChooserDialog } from './DiffCommentsAgentChooserDialog'

function formatTimestamp(ts: number): string {
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) {
    return 'just now'
  }
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }
  const days = Math.floor(hours / 24)
  if (days < 7) {
    return `${days}d ago`
  }
  return new Date(ts).toLocaleDateString()
}

function groupByFile(comments: DiffComment[]): Record<string, DiffComment[]> {
  const groups: Record<string, DiffComment[]> = {}
  for (const c of comments) {
    if (!groups[c.filePath]) {
      groups[c.filePath] = []
    }
    groups[c.filePath].push(c)
  }
  for (const list of Object.values(groups)) {
    list.sort((a, b) => a.lineNumber - b.lineNumber)
  }
  return groups
}

export function DiffCommentsTab({ activeFile }: { activeFile: OpenFile }): React.JSX.Element {
  const worktreeId = activeFile.worktreeId
  const comments = useAppStore((s) => s.getDiffComments(worktreeId))
  const deleteDiffComment = useAppStore((s) => s.deleteDiffComment)
  const clearDiffComments = useAppStore((s) => s.clearDiffComments)
  const getActiveTab = useAppStore((s) => s.getActiveTab)
  const [agentDialogOpen, setAgentDialogOpen] = useState(false)
  const [clearDialogOpen, setClearDialogOpen] = useState(false)
  const [pasteNotice, setPasteNotice] = useState<string | null>(null)

  const groups = useMemo(() => groupByFile(comments), [comments])
  const fileEntries = useMemo(() => Object.entries(groups), [groups])

  const handlePaste = (): void => {
    if (comments.length === 0) {
      return
    }
    const text = formatDiffComments(comments)
    // Why: the user's request is "paste" — don't send a trailing carriage return
    // so the AI CLI user can review the text in the terminal before submitting.
    const state = useAppStore.getState()
    const active = getActiveTab(worktreeId)
    if (!active || active.contentType !== 'terminal') {
      setPasteNotice('Focus a terminal tab in this worktree before pasting.')
      return
    }
    const ptyId = state.ptyIdsByTabId[active.entityId]?.[0]
    if (!ptyId) {
      setPasteNotice('Active terminal has no running PTY.')
      return
    }
    window.api.pty.write(ptyId, text)
    setPasteNotice(`Pasted ${comments.length} comment${comments.length === 1 ? '' : 's'}.`)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
        <MessageSquare className="size-4 text-muted-foreground" />
        <div className="text-sm font-medium">Diff Comments ({comments.length})</div>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={handlePaste}
            disabled={comments.length === 0}
            title="Paste formatted comments into the active terminal (no newline sent)"
          >
            <Clipboard className="size-3.5" />
            Paste into terminal
          </Button>
          <Button
            size="sm"
            onClick={() => setAgentDialogOpen(true)}
            disabled={comments.length === 0}
            title="Start a new terminal tab with an agent preloaded with these comments"
          >
            <Play className="size-3.5" />
            Start agent with comments
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (comments.length === 0) {
                return
              }
              setClearDialogOpen(true)
            }}
            disabled={comments.length === 0}
          >
            <Trash2 className="size-3.5" />
            Clear all
          </Button>
        </div>
      </div>

      {pasteNotice && (
        <div className="shrink-0 border-b border-border/60 bg-accent/30 px-3 py-1.5 text-xs text-muted-foreground">
          {pasteNotice}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {fileEntries.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
            No comments yet. Hover a line in the diff view and click the + in the gutter.
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {fileEntries.map(([filePath, list]) => (
              <section key={filePath} className="px-3 py-2">
                <header className="mb-1.5 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <FileCode className="size-3" />
                  <span className="truncate">{filePath}</span>
                  <span className="tabular-nums">({list.length})</span>
                </header>
                <ul className="space-y-1.5">
                  {list.map((c) => (
                    <li
                      key={c.id}
                      className="group flex items-start gap-2 rounded-md border border-border/50 bg-card px-2.5 py-1.5"
                    >
                      <span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                        L{c.lineNumber}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="whitespace-pre-wrap break-words text-xs leading-relaxed">
                          {c.body}
                        </div>
                        <div className="mt-0.5 text-[10px] text-muted-foreground">
                          {formatTimestamp(c.createdAt)}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="mt-0.5 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                        onClick={() => void deleteDiffComment(worktreeId, c.id)}
                        title="Delete comment"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>

      <Dialog open={clearDialogOpen} onOpenChange={setClearDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Clear all diff comments?</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            This will permanently delete {comments.length} comment
            {comments.length === 1 ? '' : 's'} for this worktree. This cannot be undone.
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setClearDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setClearDialogOpen(false)
                void clearDiffComments(worktreeId)
              }}
            >
              Delete all
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <DiffCommentsAgentChooserDialog
        open={agentDialogOpen}
        onOpenChange={setAgentDialogOpen}
        worktreeId={worktreeId}
        comments={comments}
      />
    </div>
  )
}
