import React, { useCallback, useMemo, useState } from 'react'
import { Bookmark, BookmarkCheck, Trash2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { SidebarSavedFilterView } from '../../../../shared/sidebar-saved-filter-view'

const EMPTY_VIEWS: readonly SidebarSavedFilterView[] = []

function makeViewId(): string {
  return `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Bookmark menu beside the filter field: apply, save, or delete named queries. */
export function SidebarSavedFilterViewsMenu({
  query,
  onApply
}: {
  query: string
  onApply: (query: string) => void
}): React.JSX.Element {
  const views = useAppStore((s) => s.settings?.sidebarSavedFilterViews ?? EMPTY_VIEWS)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [menuOpen, setMenuOpen] = useState(false)
  const [namingOpen, setNamingOpen] = useState(false)
  const [draftName, setDraftName] = useState('')

  const trimmedQuery = query.trim()
  const activeView = useMemo(
    () => views.find((view) => view.query.trim() === trimmedQuery && trimmedQuery !== ''),
    [trimmedQuery, views]
  )

  const persist = useCallback(
    (next: readonly SidebarSavedFilterView[]) => {
      void updateSettings({ sidebarSavedFilterViews: [...next] })
    },
    [updateSettings]
  )

  const saveDraft = useCallback(() => {
    const name = draftName.trim()
    if (!name || !trimmedQuery) {
      return
    }
    // Why: saving under an existing name replaces that view rather than duplicating it.
    const existing = views.find((view) => view.name.toLowerCase() === name.toLowerCase())
    const next = existing
      ? views.map((view) => (view === existing ? { ...view, query: trimmedQuery } : view))
      : [...views, { id: makeViewId(), name, query: trimmedQuery }]
    persist(next)
    setNamingOpen(false)
    setDraftName('')
  }, [draftName, persist, trimmedQuery, views])

  const label = translate(
    'auto.components.sidebar.SidebarSavedFilterViewsMenu.723d16c3eb',
    'Saved filters'
  )

  return (
    <Popover open={namingOpen} onOpenChange={setNamingOpen}>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverAnchor asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={label}
                  className="shrink-0"
                >
                  {activeView ? (
                    <BookmarkCheck className="size-3.5" />
                  ) : (
                    <Bookmark className="size-3.5" />
                  )}
                </Button>
              </DropdownMenuTrigger>
            </PopoverAnchor>
          </TooltipTrigger>
          <TooltipContent side="bottom">{activeView ? activeView.name : label}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          {views.length === 0 ? (
            <DropdownMenuItem disabled>
              {translate(
                'auto.components.sidebar.SidebarSavedFilterViewsMenu.0f0f48b5f9',
                'No saved filters yet'
              )}
            </DropdownMenuItem>
          ) : (
            views.map((view) => (
              <DropdownMenuItem
                key={view.id}
                className="group"
                onSelect={() => onApply(view.query)}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span
                    className={cn('min-w-0 flex-1 truncate', view === activeView && 'font-medium')}
                  >
                    {view.name}
                  </span>
                  <span className="min-w-0 max-w-[45%] truncate font-mono text-[10px] text-muted-foreground">
                    {view.query}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={translate(
                      'auto.components.sidebar.SidebarSavedFilterViewsMenu.3c3176fad2',
                      'Delete saved filter {{value0}}',
                      {
                        value0: view.name
                      }
                    )}
                    className="invisible shrink-0 group-hover:visible group-focus-within:visible"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation()
                      persist(views.filter((candidate) => candidate.id !== view.id))
                    }}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!trimmedQuery}
            onSelect={() => {
              setDraftName(activeView?.name ?? '')
              setNamingOpen(true)
            }}
          >
            {translate(
              'auto.components.sidebar.SidebarSavedFilterViewsMenu.c9f064aa7d',
              'Save current filter…'
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <PopoverContent align="end" className="w-64">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            saveDraft()
          }}
        >
          <Input
            autoFocus
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            placeholder={translate(
              'auto.components.sidebar.SidebarSavedFilterViewsMenu.8318903a33',
              'Filter name'
            )}
            aria-label={translate(
              'auto.components.sidebar.SidebarSavedFilterViewsMenu.8318903a33',
              'Filter name'
            )}
            maxLength={80}
          />
          <p className="truncate font-mono text-[10px] text-muted-foreground" title={trimmedQuery}>
            {trimmedQuery}
          </p>
          <div className="flex justify-end gap-1">
            <Button type="button" variant="ghost" size="xs" onClick={() => setNamingOpen(false)}>
              {translate(
                'auto.components.sidebar.SidebarSavedFilterViewsMenu.50a853e1e5',
                'Cancel'
              )}
            </Button>
            <Button type="submit" size="xs" disabled={!draftName.trim()}>
              {translate('auto.components.sidebar.SidebarSavedFilterViewsMenu.2ed6826c1d', 'Save')}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
