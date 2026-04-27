import React, { useMemo } from 'react'
import { ChevronRight, Copy } from 'lucide-react'
import { basename, dirname } from '@/lib/path'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
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
  children,
  ariaExpanded
}: {
  active: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
  ariaExpanded?: boolean
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
      aria-label={title}
      aria-pressed={active}
      aria-expanded={ariaExpanded}
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
    <div className="pt-1.5">
      {/* File header with context menu */}
      <TooltipProvider delayDuration={400}>
        <Tooltip>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto w-full justify-start gap-1 rounded-none px-2 py-0.5 text-left group"
                  onClick={onToggleCollapse}
                >
                  <ChevronRight
                    className={cn(
                      'size-3 flex-shrink-0 text-muted-foreground transition-transform',
                      !collapsed && 'rotate-90'
                    )}
                  />
                  <div className="min-w-0 flex-1 text-xs">
                    <span className="min-w-0 block truncate">
                      <span className="text-foreground">{fileName}</span>
                      {dirPath && (
                        <span className="ml-1.5 text-[11px] text-muted-foreground">{dirPath}</span>
                      )}
                    </span>
                  </div>
                  <span className="text-[10px] text-muted-foreground flex-shrink-0 bg-muted/80 rounded-full px-1.5">
                    {fileResult.matches.length}
                  </span>
                </Button>
              </TooltipTrigger>
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
          {/* Why: the row label intentionally truncates long parent paths to
             keep the result list compact, so the tooltip preserves the full
             relative path for copy/verification without widening the row. */}
          <TooltipContent side="top" sideOffset={6}>
            {fileResult.relativePath}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
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
      // Why: left-truncate the pre-match text so the highlight stays visible at
      // narrow sidebar widths. Without this, a long `before` pushes the match
      // off the right edge even with overflow ellipsis. Mirrors VS Code's
      // search view (see searchTreeModel/match.ts#preview → lcut).
      const BEFORE_MAX = 26
      const rawBefore = content.slice(0, col).trimStart()
      const before =
        rawBefore.length > BEFORE_MAX
          ? `…${rawBefore.slice(rawBefore.length - BEFORE_MAX)}`
          : rawBefore
      return {
        before,
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
          <span className="text-[10px] text-muted-foreground flex-shrink-0 tabular-nums mt-px">
            {match.line}
          </span>
          <span className="text-xs flex min-w-0 items-baseline whitespace-pre">
            <span className="text-muted-foreground flex-shrink-0">{parts.before}</span>
            {parts.match && (
              <span className="bg-amber-500/30 text-foreground rounded-sm flex-shrink-0">
                {parts.match}
              </span>
            )}
            <span className="text-muted-foreground min-w-0 truncate">{parts.after}</span>
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
