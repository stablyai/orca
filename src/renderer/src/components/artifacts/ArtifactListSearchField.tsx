import { useRef } from 'react'
import { Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

export function ArtifactListSearchField({
  query,
  onQueryChange,
  onClear,
  className
}: {
  query: string
  onQueryChange: (query: string) => void
  onClear: () => void
  className?: string
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const hasText = query !== ''

  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        type="text"
        autoFocus
        value={query}
        aria-label={translate(
          'auto.components.artifacts.ArtifactListSearchField.label',
          'Search artifacts'
        )}
        placeholder={translate(
          'auto.components.artifacts.ArtifactListSearchField.placeholder',
          'Search...'
        )}
        // Why: the page-level Escape handler blurs inputs; this opts out so the
        // first Escape clears the query without also losing focus.
        data-escape-clears-value={hasText ? 'true' : undefined}
        className={cn(
          'h-8 border-border bg-background pl-8 text-xs shadow-none focus-visible:border-ring/70 focus-visible:ring-0 dark:bg-background',
          hasText && 'pr-7'
        )}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.nativeEvent.isComposing || !hasText) {
            return
          }
          event.preventDefault()
          onClear()
        }}
      />
      {hasText ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="absolute right-1 top-1/2 -translate-y-1/2"
          aria-label={translate(
            'auto.components.artifacts.ArtifactListSearchField.clear',
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
      ) : null}
    </div>
  )
}
