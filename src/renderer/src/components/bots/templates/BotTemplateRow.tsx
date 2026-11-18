// One template in the list, as a Skills page row: mascot, name, one line, and when it runs · what it
// connects. Use shows over that meta on the current row and on focus, so nothing shifts.
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type { BotTemplate } from '../../../../../shared/bots/bot-templates'
import {
  botTemplateConnectsLine,
  botTemplateWhen
} from '../../../../../shared/bots/bot-template-view'
import { BotTemplateNeedsSetupBadge } from './BotTemplateDetail'
import { BotTemplateMascot } from './BotTemplateMascot'
import { botTemplateWhenLabel } from './bot-template-labels'

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
  const connects = botTemplateConnectsLine(template)
  const meta = [botTemplateWhenLabel(botTemplateWhen(template), t), connects]
    .filter(Boolean)
    .join(' · ')
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
        'group -mx-2 flex cursor-default items-start gap-3 rounded-md px-2 py-2.5 outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring',
        current && 'bg-accent hover:bg-accent'
      )}
    >
      <BotTemplateMascot template={template} className="mt-0.5 size-8 shrink-0 rounded-lg" />
      <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium text-foreground">{template.name}</span>
          {template.needsSetup ? <BotTemplateNeedsSetupBadge /> : null}
        </span>
        <span className="relative flex justify-end">
          <span
            className={cn(
              'truncate text-xs text-muted-foreground',
              current && 'invisible',
              'group-focus-within:invisible'
            )}
          >
            {meta}
          </span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            tabIndex={current ? 0 : -1}
            aria-label={t('bots.templates.useNamed', 'Use {{name}}', { name: template.name })}
            className={cn(
              'absolute right-0 -top-0.5',
              current ? 'visible' : 'invisible group-focus-within:visible'
            )}
            onClick={(event) => {
              event.stopPropagation()
              onUse()
            }}
          >
            {t('bots.templates.use', 'Use')}
          </Button>
        </span>
        <p className="col-span-2 min-w-0 truncate text-xs leading-5 text-muted-foreground">
          {template.line}
        </p>
      </div>
    </div>
  )
}
