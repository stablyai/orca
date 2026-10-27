import React, { useMemo } from 'react'
import { ChevronRight, Copy } from 'lucide-react'
import { basename, dirname } from '@/lib/path'
import { cn } from '@/lib/utils'
import { FileTypeIcon } from '@/components/FileTypeIcon'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem
} from '@/components/ui/context-menu'
import { normalizeSearchFileMatchCount } from '../../../../shared/search-match-count'
import type { SearchFileResult, SearchMatch } from '../../../../shared/code-search-types'
import { translate } from '@/i18n/i18n'

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
    <Tooltip>
      <TooltipTrigger asChild>
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
          aria-label={title}
          aria-pressed={active}
          aria-expanded={ariaExpanded}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {title}
      </TooltipContent>
    </Tooltip>
  )
}

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
  const matchCount = normalizeSearchFileMatchCount(fileResult)

  return (
    <div className="pt-1.5">
      <TooltipProvider delayDuration={400}>
        <Tooltip>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto w-full justify-start gap-1 rounded-none px-2 py-0.5 text-left group"
                  aria-expanded={!collapsed}
                  onClick={onToggleCollapse}
                >
                  <ChevronRight
                    className={cn(
                      'size-3 flex-shrink-0 text-muted-foreground transition-transform',
                      !collapsed && 'rotate-90',
                      'motion-reduce:transition-none'
                    )}
                  />
                  {React.createElement(FileTypeIcon, {
                    filePath: fileResult.relativePath,
                    className: 'size-3.5 flex-shrink-0 text-muted-foreground'
                  })}
                  <div className="min-w-0 flex-1 text-xs">
                    <span className="min-w-0 block truncate">
                      <span className="text-foreground">{fileName}</span>
                      {dirPath && (
                        <span className="ml-1.5 text-[11px] text-muted-foreground">{dirPath}</span>
                      )}
                    </span>
                  </div>
                  <span className="text-[10px] text-muted-foreground flex-shrink-0 bg-muted/80 rounded-full px-1.5">
                    {matchCount}
                  </span>
                </Button>
              </TooltipTrigger>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                onClick={() => window.api.ui.writeClipboardText(fileResult.relativePath)}
              >
                <Copy className="size-3.5" />
                {translate(
                  'auto.components.right.sidebar.SearchResultItems.3596b9668d',
                  'Copy Path'
                )}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
          {/* Preserve the full path in a tooltip because the row label truncates. */}
          <TooltipContent side="top" sideOffset={6}>
            {fileResult.relativePath}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}

export function MatchResultRow({
  match,
  relativePath,
  onClick
}: {
  match: SearchMatch
  relativePath: string
  onClick: () => void
}): React.JSX.Element {
  const parts = useMemo(() => {
    const content = match.lineContent
    const col = (match.displayColumn ?? match.column) - 1
    const len = match.displayMatchLength ?? match.matchLength

    if (col >= 0 && col + len <= content.length) {
      // Keep nearby context so long prefixes do not push the match out of view.
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

    return { before: content, match: '', after: '' }
  }, [
    match.lineContent,
    match.column,
    match.matchLength,
    match.displayColumn,
    match.displayMatchLength
  ])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="min-h-[18px] h-auto w-full justify-start gap-1 rounded-none py-px pr-2 pl-7 text-left"
          onMouseDown={(event) => {
            // Prevent sidebar focus so the browser cannot restore it after the editor opens.
            if (event.button === 0) {
              event.preventDefault()
            }
          }}
          onClick={onClick}
        >
          <span className="text-3xs text-muted-foreground flex-shrink-0 tabular-nums mt-px">
            {match.line}
          </span>
          <span className="text-xs flex min-w-0 flex-1 items-baseline overflow-hidden whitespace-pre">
            <span className="text-muted-foreground min-w-0 truncate">{parts.before}</span>
            {parts.match && (
              <span className="bg-annotation-highlight/30 text-foreground rounded-sm max-w-full flex-shrink-0 truncate">
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
          {translate(
            'auto.components.right.sidebar.SearchResultItems.cc06595a3b',
            'Copy Line Path'
          )}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
