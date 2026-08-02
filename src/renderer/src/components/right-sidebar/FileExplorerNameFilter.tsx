import React from 'react'
import { ListFilter, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

type FileExplorerNameFilterProps = {
  query: string
  loading?: boolean
  onQueryChange: (value: string) => void
  onClear: () => void
}

export function FileExplorerNameFilter({
  query,
  loading = false,
  onQueryChange,
  onClear
}: FileExplorerNameFilterProps): React.JSX.Element {
  return (
    <div
      className="flex h-7 items-center gap-1 rounded-sm border border-border bg-input/50 px-1.5 focus-within:border-ring"
      data-ignore-file-explorer-keys="true"
    >
      <ListFilter className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        type="text"
        className="min-w-0 flex-1 bg-transparent py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground/50"
        aria-label={translate(
          'auto.components.right.sidebar.FileExplorerNameFilter.26fb73c6e3',
          'Find files'
        )}
        placeholder={translate(
          'auto.components.right.sidebar.FileExplorerNameFilter.26fb73c6e3',
          'Find files'
        )}
        value={query}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
        spellCheck={false}
      />
      {loading ? <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" /> : null}
      {query ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="h-auto w-auto rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
          aria-label={translate(
            'auto.components.right.sidebar.FileExplorerNameFilter.4d5a6b2a49',
            'Clear file filter'
          )}
          onClick={onClear}
        >
          <X className="size-3" />
        </Button>
      ) : null}
    </div>
  )
}
