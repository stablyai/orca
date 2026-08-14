import { useMemo, useRef, useState } from 'react'
import { Copy, ExternalLink, Loader2, Search, Trash2 } from 'lucide-react'
import type { ArtifactListItem } from '../../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  artifactName,
  artifactTypeIcon,
  formatArtifactDate,
  formatArtifactExpiry,
  formatArtifactUpdatedAt,
  formatByteSize
} from './artifact-display-labels'
import { copyArtifactLink, openArtifactInBrowser } from './artifact-link-actions'

const OPTION_SELECTOR = '[role="option"]'

function moveOptionFocus(listbox: HTMLElement | null, from: HTMLElement, step: number): void {
  const options = [...(listbox?.querySelectorAll<HTMLElement>(OPTION_SELECTOR) ?? [])]
  const next = options[options.indexOf(from) + step]
  next?.focus()
}

function focusEdgeOption(listbox: HTMLElement | null, edge: 'first' | 'last'): void {
  const options = [...(listbox?.querySelectorAll<HTMLElement>(OPTION_SELECTOR) ?? [])]
  const target = edge === 'first' ? options.at(0) : options.at(-1)
  target?.focus()
}

export function ArtifactListPane({
  artifacts,
  className,
  deletingId,
  selectedArtifact,
  selectArtifact,
  deleteArtifact,
  hasMore,
  loadingMore,
  loadMore
}: {
  artifacts: readonly ArtifactListItem[]
  className?: string
  deletingId: string | null
  selectedArtifact: ArtifactListItem
  selectArtifact: (slug: string) => void
  deleteArtifact: (item: ArtifactListItem) => void
  hasMore: boolean
  loadingMore: boolean
  loadMore: () => void
}): React.JSX.Element {
  const listboxRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const matches = useMemo(
    () =>
      normalizedQuery
        ? artifacts.filter((item) => artifactName(item).toLowerCase().includes(normalizedQuery))
        : artifacts,
    [artifacts, normalizedQuery]
  )

  // Why: arrows move focus only — committing selection would reload the preview webview on every keypress.
  const onOptionKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, slug: string): void => {
    const option = event.currentTarget
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveOptionFocus(listboxRef.current, option, 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveOptionFocus(listboxRef.current, option, -1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusEdgeOption(listboxRef.current, 'first')
    } else if (event.key === 'End') {
      event.preventDefault()
      focusEdgeOption(listboxRef.current, 'last')
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      selectArtifact(slug)
    }
  }

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="relative shrink-0 border-b border-border/40 px-2 py-2">
        <Search className="pointer-events-none absolute left-4.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={translate(
            'auto.components.artifacts.ArtifactListPane.search',
            'Search artifacts'
          )}
          className="h-8 pl-8 text-sm"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
        <div
          ref={listboxRef}
          role="listbox"
          aria-label={translate(
            'auto.components.artifacts.ArtifactListPane.listLabel',
            'Shared artifacts'
          )}
          aria-orientation="vertical"
        >
          {matches.map((item) => {
            const selected = item.artifact.slug === selectedArtifact.artifact.slug
            const name = artifactName(item)
            const TypeIcon = artifactTypeIcon(item)
            return (
              <ContextMenu key={item.artifact.slug}>
                <ContextMenuTrigger asChild>
                  <div
                    role="option"
                    aria-selected={selected}
                    aria-current={selected ? 'page' : undefined}
                    data-current={selected ? 'true' : undefined}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => selectArtifact(item.artifact.slug)}
                    onKeyDown={(event) => onOptionKeyDown(event, item.artifact.slug)}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-3 border-b border-border/50 px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      selected && 'bg-accent'
                    )}
                  >
                    <TypeIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="block truncate text-sm font-medium">{name}</span>
                        </TooltipTrigger>
                        <TooltipContent side="right" sideOffset={6}>
                          <p className="font-medium">{name}</p>
                          <p className="text-background/70">
                            {formatArtifactDate(item.artifact.updatedAt)}
                          </p>
                          <p className="text-background/70">
                            {formatArtifactExpiry(item.artifact.expiresAt)}
                          </p>
                        </TooltipContent>
                      </Tooltip>
                      <span className="block truncate text-xs text-muted-foreground">
                        {formatArtifactUpdatedAt(item.artifact.updatedAt)} ·{' '}
                        {formatByteSize(item.artifact.byteSize)}
                      </span>
                    </span>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => void copyArtifactLink(item.shareUrl)}>
                    <Copy />
                    {translate('auto.components.artifacts.copyLink', 'Copy link')}
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => openArtifactInBrowser(item.shareUrl)}>
                    <ExternalLink />
                    {translate('auto.components.artifacts.openInBrowser', 'Open in browser')}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    variant="destructive"
                    disabled={deletingId === item.artifact.slug}
                    onSelect={() => deleteArtifact(item)}
                  >
                    <Trash2 />
                    {translate(
                      'auto.components.artifacts.ArtifactsPage.deleteArtifact',
                      'Delete artifact'
                    )}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            )
          })}
        </div>
        {matches.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {translate('auto.components.artifacts.ArtifactListPane.noMatches', 'No matches')}
          </p>
        ) : null}
        {hasMore ? (
          <div className="border-t border-border/50 p-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full"
              disabled={loadingMore}
              onClick={loadMore}
            >
              {loadingMore ? <Loader2 className="animate-spin" /> : null}
              {translate('auto.components.artifacts.ArtifactCollection.loadMore', 'Load more')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
