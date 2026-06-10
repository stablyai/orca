import React, { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import DiffViewer from './DiffViewer'
import { useClaudeIdeDiff, type IdeDiffRequest } from './useClaudeIdeDiff'

function DiffRequestCard({
  req,
  resolve
}: {
  req: IdeDiffRequest
  resolve: (requestId: string, worktreeId: string, verdict: 'keep' | 'reject') => void
}): React.ReactElement {
  // Why: without the old file's real contents the diff renders as 100%
  // additions; an unreadable/missing oldPath means a new file (empty base).
  const [originalContent, setOriginalContent] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    window.api.fs
      .readFile({ filePath: req.oldPath })
      .then((file) => {
        if (!cancelled) {
          setOriginalContent(file.isBinary ? '' : file.content)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOriginalContent('')
        }
      })
    return () => {
      cancelled = true
    }
  }, [req.oldPath])

  return (
    <div className="flex w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <span className="truncate text-sm font-medium text-foreground">
          Claude Code — Review changes to <span className="font-mono text-xs">{req.newPath}</span>
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="default"
            onClick={() => resolve(req.requestId, req.worktreeId, 'keep')}
          >
            Keep
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => resolve(req.requestId, req.worktreeId, 'reject')}
          >
            Reject
          </Button>
        </div>
      </div>
      <div className="h-[60vh] min-h-[300px]">
        {originalContent !== null && (
          <DiffViewer
            modelKey={`claude-ide-diff-${req.requestId}`}
            originalContent={originalContent}
            modifiedContent={req.newContents}
            language="plaintext"
            filePath={req.newPath}
            relativePath={req.newPath}
            sideBySide={true}
            worktreeId={req.worktreeId}
          />
        )}
      </div>
    </div>
  )
}

/**
 * ClaudeIdeDiffPanel
 *
 * Renders a stacked list of pending Claude IDE diff requests, each with
 * Keep / Reject buttons.  Mount this once at the top of the renderer
 * (e.g. inside App.tsx) so it is always present to handle IPC events.
 */
export function ClaudeIdeDiffPanel(): React.ReactElement | null {
  const { requests, resolve } = useClaudeIdeDiff()

  if (requests.length === 0) {return null}

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/60 p-4">
      {requests.map((req) => (
        <DiffRequestCard key={req.requestId} req={req} resolve={resolve} />
      ))}
    </div>
  )
}
