import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type { BotTemplate } from '../../../../../shared/bots/bot-templates'
import { botTemplateText } from '../../../../../shared/bots/bot-template-text'
import { BotTemplateNeedsSetupBadge } from './BotTemplateDetail'
import { BotTemplateMascot } from './BotTemplateMascot'

export function BotTemplateRow({
  template,
  current,
  onSelect,
  onUse,
  rowRef
}: {
  template: BotTemplate
  current: boolean
  onSelect: () => void
  onUse: () => void
  rowRef?: (element: HTMLDivElement | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const name = botTemplateText(template.name, t)
  return (
    <div
      ref={rowRef}
      role="option"
      aria-selected={current}
      data-current={current}
      tabIndex={-1}
      onClick={onSelect}
      onDoubleClick={onUse}
      className={cn(
        'group -mx-2 flex cursor-default items-center gap-3 rounded-md px-2 py-2.5 outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring',
        current && 'bg-accent hover:bg-accent'
      )}
    >
      <BotTemplateMascot template={template} className="size-8 shrink-0 rounded-lg" />
      <div className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium text-foreground">{name}</span>
          {template.needsSetup ? <BotTemplateNeedsSetupBadge /> : null}
        </span>
        <p className="truncate text-xs leading-5 text-muted-foreground">
          {botTemplateText(template.line, t)}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="xs"
        tabIndex={current ? 0 : -1}
        aria-label={t('bots.templates.useNamed', 'Use {{name}}', { name })}
        className={current ? undefined : 'invisible group-focus-within:visible'}
        onClick={(event) => {
          event.stopPropagation()
          onUse()
        }}
      >
        {t('bots.templates.use', 'Use')}
      </Button>
    </div>
  )
}
