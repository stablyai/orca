import { ImeInput } from '@/lib/text-input/ime/ime-text-field'
import React, { useCallback, useEffect, useRef } from 'react'
import { Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'

export type SourceControlFileFilterProps = {
  filterQuery: string
  filterExpanded: boolean
  onFilterQueryChange: (value: string) => void
  onFilterExpandedChange: (expanded: boolean) => void
}

export function SourceControlFilterToggle({
  filterQuery,
  filterExpanded,
  onFilterExpandedChange,
  embedded,
  className,
  ref
}: Pick<
  SourceControlFileFilterProps,
  'filterQuery' | 'filterExpanded' | 'onFilterExpandedChange'
> & {
  /** A folder card's header button toggles the filter row instead of only opening it. */
  embedded: boolean
  className?: string
  ref?: React.Ref<HTMLButtonElement>
}): React.JSX.Element {
  const t = useTranslate()
  const normalizedFilter = filterQuery.trim()
  const title = normalizedFilter
    ? t('auto.components.right.sidebar.SourceControl.c8e4a1f902', 'Filter: {{value0}}', {
        value0: filterQuery
      })
    : t('auto.components.right.sidebar.SourceControl.b3c8f1a902', 'Filter files by name')
  return (
    <button
      ref={ref}
      type="button"
      data-testid="source-control-filter-toggle"
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
        className ?? (embedded ? 'size-6' : 'size-7'),
        (normalizedFilter || (embedded && filterExpanded)) && 'bg-muted text-foreground'
      )}
      onClick={() => onFilterExpandedChange(embedded ? !filterExpanded : true)}
      aria-label={title}
      title={title}
      aria-expanded={embedded ? filterExpanded : false}
    >
      <Search className="size-3.5" />
      {normalizedFilter ? (
        <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-foreground" />
      ) : null}
    </button>
  )
}

/** The expanded filter input; it takes its row so typing is never squeezed by other controls. */
export function SourceControlFilterRow({
  filterQuery,
  filterExpanded,
  onFilterQueryChange,
  onFilterExpandedChange,
  onCollapsed
}: SourceControlFileFilterProps & {
  /** Runs after Escape or the clear button closes the row, e.g. to return focus to the toggle. */
  onCollapsed?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const filterInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!filterExpanded) {
      return
    }
    filterInputRef.current?.focus()
    filterInputRef.current?.select()
  }, [filterExpanded])

  const collapse = useCallback(() => {
    onFilterExpandedChange(false)
    onCollapsed?.()
  }, [onCollapsed, onFilterExpandedChange])

  const clearAndCollapse = useCallback(() => {
    onFilterQueryChange('')
    collapse()
  }, [collapse, onFilterQueryChange])

  const placeholder = t('auto.components.right.sidebar.SourceControl.c35baf2f1e', 'Filter files…')
  const clearLabel = t(
    'auto.components.right.sidebar.SourceControl.d4f8c2a901',
    'Clear and close filter'
  )
  return (
    <>
      <div className="flex min-w-0 w-full flex-1 items-center gap-1.5">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <ImeInput
          ref={filterInputRef}
          data-testid="source-control-filter-input"
          type="text"
          value={filterQuery}
          onChange={(event) => onFilterQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              collapse()
            }
          }}
          placeholder={placeholder}
          className="min-w-0 w-full flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          aria-label={placeholder}
        />
      </div>
      <Button
        type="button"
        variant="ghost-muted"
        size="icon-xs"
        className="shrink-0"
        aria-label={clearLabel}
        title={clearLabel}
        onClick={clearAndCollapse}
      >
        <X className="size-3.5" />
      </Button>
    </>
  )
}
