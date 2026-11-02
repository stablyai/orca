import { ArrowRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export function TabAgentSearchHint({
  examples,
  onDismiss,
  onTry
}: {
  examples: readonly string[]
  onDismiss: () => void
  onTry: (query: string) => void
}): React.JSX.Element {
  return (
    <div
      id="tab-agent-search-hint"
      className="relative mx-2 mt-3 mb-2 rounded-lg border border-border bg-muted p-3 text-foreground"
    >
      <span
        aria-hidden="true"
        className="absolute -top-1.5 left-5 size-3 rotate-45 border-t border-l border-border bg-muted"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="absolute top-1.5 right-1.5"
        aria-label={translate('tabAgentSearchHint.dismiss', 'Dismiss agent search hint')}
        onClick={onDismiss}
      >
        <X />
      </Button>
      <p className="pr-5 text-xs leading-5 font-medium">
        {translate('tabAgentSearchHint.title', 'Find and launch agents here')}
      </p>
      <p className="mt-1 text-xs leading-4 text-muted-foreground">
        {translate('tabAgentSearchHint.description', 'Type a model name in the search box above.')}
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {examples.map((model, index) => (
          <Button
            key={model}
            type="button"
            variant={index === 0 ? 'default' : 'outline'}
            size="xs"
            onClick={() => onTry(model)}
          >
            {translate('tabAgentSearchHint.tryModel', 'Try “{{model}}”', { model })}
            <ArrowRight />
          </Button>
        ))}
      </div>
    </div>
  )
}
