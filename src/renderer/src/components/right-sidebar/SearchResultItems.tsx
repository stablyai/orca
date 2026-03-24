import React, { useMemo } from 'react'
import { ChevronRight, File, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'
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
    <button
      className={cn(
        'p-0.5 rounded-sm flex-shrink-0 transition-colors',
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted'
      )}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  )
}

// ─── File Result ──────────────────────────────────────────
export function FileResultItem({
  fileResult,
  collapsed,
  onToggleCollapse,
  onMatchClick
}: {
  fileResult: SearchFileResult
  collapsed: boolean
  onToggleCollapse: () => void
  onMatchClick: (match: SearchMatch) => void
}): React.JSX.Element {
  const fileName = fileResult.relativePath.split('/').pop() ?? fileResult.relativePath
  const dirPath = fileResult.relativePath.includes('/')
    ? fileResult.relativePath.slice(0, fileResult.relativePath.lastIndexOf('/'))
    : ''

  return (
    <div>
      {/* File header with context menu */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            className="flex items-center gap-1 w-full px-2 py-0.5 hover:bg-muted/50 text-left group"
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
          </button>
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

      {/* Matches */}
      {!collapsed &&
        fileResult.matches.map((match, i) => (
          <MatchItem
            key={`${match.line}:${match.column}:${i}`}
            match={match}
            relativePath={fileResult.relativePath}
            onClick={() => onMatchClick(match)}
          />
        ))}
    </div>
  )
}

// ─── Match Item ───────────────────────────────────────────
export function MatchItem({
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
        <button
          className="flex items-start gap-1 w-full pl-7 pr-2 py-px hover:bg-muted/50 text-left min-h-[18px]"
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
        </button>
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
