import { useState } from 'react'
import { Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'

export function ArtifactListSearchField({
  inputRef,
  query,
  onQueryChange,
  onClear,
  className
}: {
  inputRef: React.RefObject<HTMLInputElement | null>
  query: string
  onQueryChange: (query: string) => void
  onClear: () => void
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const hasText = query !== ''
  const [showFocusRing, setShowFocusRing] = useState(false)

  return (
    <div className={cn('relative w-full', className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        type="text"
        // Shell focus recovery lands here when the page opens without its own autofocus (D1 R7).
        data-rail-page-focus-target=""
        value={query}
        aria-label={t(
          'auto.components.artifacts.ArtifactListSearchField.label',
          'Search artifacts'
        )}
        placeholder={t(
          'auto.components.artifacts.ArtifactListSearchField.placeholder',
          'Search...'
        )}
        // Let the first Escape clear search without the page-level handler also blurring it.
        data-escape-clears-value={hasText ? 'true' : undefined}
        density="compact"
        inset="leadingIcon"
        adornment="trailing"
        focusFeedback={showFocusRing ? 'default' : 'quiet'}
        onPointerDown={() => setShowFocusRing(false)}
        onBlur={() => setShowFocusRing(true)}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          setShowFocusRing(true)
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
          className="absolute right-0.5 top-1/2 -translate-y-1/2"
          aria-label={t('auto.components.artifacts.ArtifactListSearchField.clear', 'Clear search')}
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
