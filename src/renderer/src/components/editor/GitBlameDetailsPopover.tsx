import { useMemo } from 'react'
import { Copy, ExternalLink, GitCompareArrows } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import type { GitBlameDetailsRequest } from './use-monaco-git-blame'

export function GitBlameDetailsPopover({
  request,
  onClose,
  onCopyHash,
  onOpenRemoteCommit,
  onOpenCommitDiff
}: {
  request: GitBlameDetailsRequest | null
  onClose: () => void
  onCopyHash: () => Promise<void>
  onOpenRemoteCommit: () => Promise<void>
  onOpenCommitDiff: () => Promise<void>
}): React.JSX.Element {
  const virtualRef = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () =>
          new DOMRect(request?.anchorX ?? 0, request?.anchorY ?? 0, 0, 0)
      }
    }),
    [request?.anchorX, request?.anchorY]
  )
  const range = request?.range
  const committed = Boolean(range?.commitId)

  return (
    <Popover open={request !== null} onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor virtualRef={virtualRef} />
      {range ? (
        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={6}
          collisionPadding={8}
          className="w-[min(28rem,calc(100vw-1rem))] p-0"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <div className="border-b border-border px-3 py-2">
            <div className="text-sm font-medium text-foreground">{range.summary}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {range.author}
              {range.authorEmail ? ` <${range.authorEmail}>` : ''}
            </div>
            <div className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
              {new Date(range.authoredAt * 1000).toLocaleString()}
              {range.commitId ? ` · ${range.commitId}` : ' · Uncommitted line'}
            </div>
          </div>
          <div className="flex flex-wrap gap-1 p-1.5">
            <Button size="xs" variant="ghost" disabled={!committed} onClick={onOpenCommitDiff}>
              <GitCompareArrows />
              Open diff
            </Button>
            <Button size="xs" variant="ghost" disabled={!committed} onClick={onCopyHash}>
              <Copy />
              Copy hash
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={!committed}
              onClick={onOpenRemoteCommit}
            >
              <ExternalLink />
              Open remote
            </Button>
          </div>
        </PopoverContent>
      ) : null}
    </Popover>
  )
}
