import { ArrowRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

export function TabAgentSearchHint({
  examples,
  onDismiss,
  onTry
}: {
  examples: readonly string[]
  onDismiss: () => void
  onTry: (query: string) => void
}): React.JSX.Element {
  const t = useTranslate()
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
        aria-label={t('tabAgentSearchHint.dismiss', 'Dismiss agent search hint')}
        onClick={onDismiss}
      >
        <X />
      </Button>
      <p className="pr-5 text-xs leading-5 font-medium">
        {t('tabAgentSearchHint.title', 'Find and launch agents here')}
      </p>
      <p className="mt-1 text-xs leading-4 text-muted-foreground">
        {t('tabAgentSearchHint.description', 'Type a model name in the search box above.')}
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
            {t('tabAgentSearchHint.tryModel', 'Try “{{model}}”', { model })}
            <ArrowRight />
          </Button>
        ))}
      </div>
    </div>
  )
}
