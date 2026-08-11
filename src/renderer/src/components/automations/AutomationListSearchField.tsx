import React, { useRef } from 'react'
import { Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

type AutomationListSearchFieldProps = {
  query: string
  isTooLarge: boolean
  onQueryChange: (query: string) => void
  onClear: () => void
  className?: string
}

export function AutomationListSearchField({
  query,
  isTooLarge,
  onQueryChange,
  onClear,
  className
}: AutomationListSearchFieldProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const hasText = query !== ''
  const tooLargeMessage = isTooLarge
    ? translate(
        'auto.components.automations.AutomationListSearchField.tooLong',
        'Search text is too long — list is unfiltered'
      )
    : null

  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        type="text"
        autoFocus
        value={query}
        aria-label={translate(
          'auto.components.automations.AutomationListSearchField.label',
          'Search automations'
        )}
        placeholder={translate(
          'auto.components.automations.AutomationListSearchField.placeholder',
          'Search...'
        )}
        aria-invalid={isTooLarge || undefined}
        aria-describedby={isTooLarge ? 'automations-list-search-too-large' : undefined}
        // Why: the page-level capture Escape handler blurs inputs; this opts out
        // so the first Escape clears the query without also losing focus.
        data-escape-clears-value={hasText ? 'true' : undefined}
        className={cn(
          // Flat list search: no elevation/halo; soft focus border only.
          'h-8 border-border bg-background pl-8 text-xs shadow-none focus-visible:border-ring/70 focus-visible:ring-0 dark:bg-background',
          hasText && (isTooLarge ? 'pr-20' : 'pr-7')
        )}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.nativeEvent.isComposing) {
            return
          }
          if (!hasText) {
            return
          }
          event.preventDefault()
          onClear()
        }}
      />
      {hasText ? (
        <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
          {isTooLarge ? (
            <span
              id="automations-list-search-too-large"
              title={tooLargeMessage ?? undefined}
              className="text-[10px] text-destructive"
            >
              {translate(
                'auto.components.automations.AutomationListSearchField.tooLongShort',
                'Too long'
              )}
            </span>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate(
              'auto.components.automations.AutomationListSearchField.clear',
              'Clear search'
            )}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onClear()
              inputRef.current?.focus()
            }}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ) : null}
      {isTooLarge ? (
        <div role="status" aria-live="polite" className="sr-only">
          {tooLargeMessage}
        </div>
      ) : null}
    </div>
  )
}
