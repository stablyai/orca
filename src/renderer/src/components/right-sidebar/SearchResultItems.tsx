import React, { useMemo } from 'react'
import { ChevronRight, File, Copy } from 'lucide-react'
import { basename, dirname } from '@/lib/path'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem
} from '@/components/ui/context-menu'
import type { SearchFileResult, SearchMatch } from '../../../../shared/types'

// ─── Toggle Button ────────────────────────────────────────
export function ToggleButton({
  active,
  onClick,
  title,
  children
}: {
  active: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className={cn(
        'h-auto w-auto rounded-sm p-0.5 flex-shrink-0',
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted'
      )}
      onClick={onClick}
      title={title}
    >
      {children}
    </Button>
  )
}

// ─── File Result ──────────────────────────────────────────
export function FileResultRow({
  fileResult,
  onToggleCollapse,
  collapsed
}: {
  fileResult: SearchFileResult
  onToggleCollapse: () => void
  collapsed: boolean
}): React.JSX.Element {
  const fileName = basename(fileResult.relativePath)
  const parentDir = dirname(fileResult.relativePath)
  const dirPath = parentDir === '.' ? '' : parentDir

  return (
    <div>
      {/* File header with context menu */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full justify-start gap-1 rounded-none px-2 py-0.5 text-left group"
            onClick={onToggleCollapse}
          >
            <ChevronRight
              size={12}
              className={cn(
                'flex-shrink-0 text-muted-foreground transition-transform',
                !collapsed && 'rotate-90'
              )}
            />
            <File size={12} className="flex-shrink-0 text-muted-foreground" />
            <span className="text-xs text-foreground truncate">{fileName}</span>
            {dirPath && (
              <span className="text-[10px] text-muted-foreground truncate ml-1">{dirPath}</span>
            )}
            <span className="ml-auto text-[10px] text-muted-foreground flex-shrink-0 bg-muted/80 rounded-full px-1.5">
              {fileResult.matches.length}
            </span>
          </Button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onClick={() => window.api.ui.writeClipboardText(fileResult.relativePath)}
          >
            <Copy className="size-3.5" />
            Copy Path
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}

// ─── Match Item ───────────────────────────────────────────
export function MatchResultRow({
  match,
  relativePath,
  onClick
}: {
  match: SearchMatch
  relativePath: string
  onClick: () => void
}): React.JSX.Element {
  // Highlight the matched text within the line
  const parts = useMemo(() => {
    const content = match.lineContent
    const col = match.column - 1 // convert to 0-indexed
    const len = match.matchLength

    if (col >= 0 && col + len <= content.length) {
      return {
        before: content.slice(0, col),
        match: content.slice(col, col + len),
        after: content.slice(col + len)
      }
    }

    // Fallback
    return { before: content, match: '', after: '' }
  }, [match.lineContent, match.column, match.matchLength])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="min-h-[18px] h-auto w-full justify-start gap-1 rounded-none py-px pr-2 pl-7 text-left"
          onMouseDown={(event) => {
            // Why: clicking a result should move focus into the opened editor.
            // If the sidebar button takes focus first, the browser can restore
            // it after the click and make the initial reveal feel flaky.
            if (event.button === 0) {
              event.preventDefault()
            }
          }}
          onClick={onClick}
        >
          <span className="text-[10px] text-muted-foreground flex-shrink-0 w-8 text-right tabular-nums mt-px">
            {match.line}
          </span>
          <span className="text-xs truncate">
            <span className="text-muted-foreground">{parts.before.trimStart()}</span>
            {parts.match && (
              <span className="bg-amber-500/30 text-foreground rounded-sm">{parts.match}</span>
            )}
            <span className="text-muted-foreground">{parts.after}</span>
          </span>
        </Button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onClick={() => window.api.ui.writeClipboardText(`${relativePath}#L${match.line}`)}
        >
          <Copy className="size-3.5" />
          Copy Line Path
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
