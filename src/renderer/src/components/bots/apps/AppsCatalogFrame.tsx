// A wide catalog dialog's frame: its title, what's added and Close; the search beside the custom
// entry's button; the filter chips; then the list they filter. Add apps (bots) and Add an MCP server
// (Settings) both draw it.
import React, { useDeferredValue } from 'react'
import { Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'

export function AppsCatalogFrame({
  title,
  added,
  onClose,
  query,
  onQuery,
  searchLabel,
  searchRef,
  custom,
  chips,
  listRef,
  children
}: {
  title: string
  /** The "N added" toggle, when anything is. */
  added: React.ReactNode
  onClose: () => void
  query: string
  onQuery: (query: string) => void
  searchLabel: string
  searchRef: React.Ref<HTMLInputElement>
  /** The button beside the search: Add by URL, Custom server. */
  custom: React.ReactNode
  chips: React.ReactNode
  listRef: React.Ref<HTMLDivElement>
  /** The list, mounted once the dialog and its search have painted. */
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const showList = useDeferredValue(true, false)
  return (
    <>
      <div className="flex h-16 shrink-0 items-center gap-2 pr-4.5 pl-6">
        <DialogTitle className="min-w-0 flex-1">
          <span className="block truncate" title={title}>
            {title}
          </span>
        </DialogTitle>
        {added}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('bots.apps.close', 'Close')}
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="flex shrink-0 flex-col gap-3 px-6">
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              autoFocus
              type="text"
              value={query}
              onChange={(event) => onQuery(event.target.value)}
              placeholder={searchLabel}
              aria-label={searchLabel}
              inset="leadingIcon"
              className="h-9.5"
            />
          </div>
          {custom}
        </div>
        {chips}
      </div>
      <div
        ref={listRef}
        aria-busy={!showList}
        className="scrollbar-sleek @container mt-1 min-h-0 flex-1 overflow-y-auto px-4 pb-4"
      >
        {showList ? children : null}
      </div>
    </>
  )
}
