import { FolderCheck, LoaderCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { ExistingCheckoutSuggestionsState } from './use-existing-checkout-suggestions'

export function ExistingCheckoutSuggestionList({
  state,
  disabled,
  onUse
}: {
  state: ExistingCheckoutSuggestionsState
  disabled: boolean
  onUse: (path: string) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  if (state.loading) {
    return (
      <div
        className="flex items-center gap-2 px-1 py-1 text-xs text-muted-foreground"
        role="status"
      >
        <LoaderCircle className="size-3.5 animate-spin" />
        {t(
          'auto.components.new.workspace.SetProjectLocationDialog.existingCheckoutsSearching',
          'Looking for existing checkouts on this host…'
        )}
      </div>
    )
  }
  if (state.suggestions.length === 0) {
    return null
  }
  return (
    <div className="space-y-1" data-testid="existing-checkout-suggestions">
      <div className="px-1 text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
        {t(
          'auto.components.new.workspace.SetProjectLocationDialog.existingCheckoutsHeading',
          'Found on this host'
        )}
      </div>
      {state.suggestions.map((suggestion) => (
        <button
          key={suggestion.path}
          type="button"
          disabled={disabled}
          onClick={() => onUse(suggestion.path)}
          className={cn(
            'flex w-full items-center gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-left transition-colors',
            'hover:bg-accent focus-visible:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
            'disabled:pointer-events-none disabled:opacity-50'
          )}
        >
          <FolderCheck className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium leading-5">
              {t(
                'auto.components.new.workspace.SetProjectLocationDialog.existingCheckoutsUse',
                'Use this folder'
              )}
            </span>
            <span
              className="block truncate font-mono text-xs text-muted-foreground"
              title={suggestion.path}
            >
              {suggestion.path}
            </span>
          </span>
          <Badge variant="referenceLabel">
            {suggestion.match === 'remote'
              ? t(
                  'auto.components.new.workspace.SetProjectLocationDialog.existingCheckoutsSameRemote',
                  'Same remote'
                )
              : t(
                  'auto.components.new.workspace.SetProjectLocationDialog.existingCheckoutsSameName',
                  'Same name'
                )}
          </Badge>
        </button>
      ))}
    </div>
  )
}
