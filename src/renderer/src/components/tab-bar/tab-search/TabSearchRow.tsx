import type React from 'react'
import { FileText, MessageSquare, Smartphone, SquareTerminal, X } from 'lucide-react'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { BrowserFavicon } from '@/components/browser-pane/describe-page/browser-favicon'
import { Button } from '@/components/ui/button'
import { CommandItem } from '@/components/ui/command'
import { useTranslate } from '@/i18n/use-translate'
import { isEditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'
import type { OpenTabPaletteItem } from '@/components/worktree-jump/worktree-jump-palette-model'
import {
  PaletteLocationChip,
  PaletteOpenTabPrimaryLine
} from '@/components/worktree-jump/rows/worktree-jump-palette-row-content'

function TabSearchIcon({ item }: { item: OpenTabPaletteItem }): React.JSX.Element {
  if (item.type === 'browser-page') {
    return <BrowserFavicon faviconUrl={item.result.faviconUrl} className="size-3.5" />
  }
  if (item.type === 'simulator-tab') {
    return <Smartphone className="size-3.5" aria-hidden="true" />
  }
  const { occupantAgent, contentType } = item.result
  if (occupantAgent) {
    return (
      <span className="inline-flex" data-agent-icon={occupantAgent} aria-hidden="true">
        <AgentIcon agent={occupantAgent} size={14} />
      </span>
    )
  }
  if (contentType === 'terminal') {
    return <SquareTerminal className="size-3.5" aria-hidden="true" />
  }
  if (contentType === 'agent-session') {
    return <MessageSquare className="size-3.5" aria-hidden="true" />
  }
  return <FileText className="size-3.5" aria-hidden="true" />
}

export function TabSearchRow({
  item,
  onSelect,
  onClose
}: {
  item: OpenTabPaletteItem
  onSelect: (item: OpenTabPaletteItem) => void
  onClose: (item: OpenTabPaletteItem) => void
}): React.JSX.Element {
  const t = useTranslate()
  const { result } = item
  const isCurrent =
    item.type === 'browser-page' ? item.result.isCurrentPage : item.result.isCurrentTab
  return (
    <CommandItem value={item.id} onSelect={() => onSelect(item)} shape="palette-row">
      <div className="flex h-5 w-4 shrink-0 items-center justify-center self-start text-muted-foreground/85">
        <TabSearchIcon item={item} />
      </div>
      <div className="min-w-0 flex-1 overflow-hidden">
        <PaletteOpenTabPrimaryLine
          title={result.title}
          titleRanges={result.titleRanges}
          secondaryText={result.secondaryText}
          secondaryRanges={result.secondaryRanges}
          secondaryMatches={result.secondaryMatches}
          elideSecondaryPathHead={
            item.type === 'browser-page' ||
            (item.type === 'workspace-tab' && isEditorTabContentType(item.result.contentType))
          }
          leadingBadges={
            isCurrent ? (
              <span className="shrink-0 self-center rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                {t('auto.components.WorktreeJumpPalette.52404f8096', 'Current Tab')}
              </span>
            ) : null
          }
        />
      </div>
      <div className="flex min-w-0 max-w-[40%] items-center justify-end gap-1.5">
        <PaletteLocationChip
          repoName={result.repoName}
          repoRanges={result.repoRanges}
          worktreeName={result.worktreeName}
          worktreeRanges={result.worktreeRanges}
        />
        {/* Chrome shows the close button on the hovered or selected row only. */}
        <span className="flex opacity-0 group-hover:opacity-100 group-data-[selected=true]:opacity-100">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            tabIndex={-1}
            aria-label={t(
              'auto.components.tab.bar.tab.search.TabSearchRow.10e04285dd',
              'Close tab'
            )}
            // Why: the row stays keyboard-driven, so the search field keeps focus and cmdk never selects the row.
            onPointerDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onClose(item)
            }}
          >
            <X aria-hidden="true" />
          </Button>
        </span>
      </div>
    </CommandItem>
  )
}
