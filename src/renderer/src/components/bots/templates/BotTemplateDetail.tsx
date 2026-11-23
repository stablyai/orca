// A template's detail: what it is, what its bot posts, what it does first, and what it comes with. Its
// header (picture, name, line, Use template…) stays pinned; the rest scrolls under it.
import { useState } from 'react'
import { BadgeCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type { BotTemplate } from '../../../../../shared/bots/bot-templates'
import { botTemplateWord } from '../../../../../shared/bots/bot-template-text'
import { BotTemplateComesWith, BotTemplateComesWithHeading } from './BotTemplateComesWith'
import { BotTemplateMascot } from './BotTemplateMascot'
import { botTemplateCategoryLabel } from './bot-template-labels'

const SECTION_TITLE = 'mb-1.5 text-xs font-medium text-muted-foreground'

export function BotTemplateNeedsSetupBadge(): React.JSX.Element {
  const t = useTranslate()
  return <Badge variant="referenceLabel">{t('bots.templates.needsSetup', 'Needs setup')}</Badge>
}

export function BotTemplateDetail({
  template,
  onUse
}: {
  template: BotTemplate
  onUse: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [scrolled, setScrolled] = useState(false)
  const name = botTemplateWord(template, 'name', t)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          'flex shrink-0 flex-col gap-5 border-b border-transparent px-6 pt-6 pb-5',
          scrolled && 'border-border'
        )}
      >
        <div className="flex items-center gap-3">
          <BotTemplateMascot template={template} className="size-14 rounded-xl" />
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
              <span className="truncate">{name}</span>
              {template.needsSetup ? <BotTemplateNeedsSetupBadge /> : null}
            </h2>
            <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              <span>{botTemplateCategoryLabel(template.category, t)}</span>
              <span className="inline-flex items-center gap-1">
                <span aria-hidden="true">·</span>
                {t('bots.templates.publisher', 'by Orca')}
                <BadgeCheck
                  className="size-3.5 shrink-0 text-callout-note"
                  role="img"
                  aria-label={t('bots.templates.official', 'Official Orca template')}
                />
              </span>
            </p>
          </div>
        </div>
        <p className="text-sm text-foreground">{botTemplateWord(template, 'line', t)}</p>
        <Button type="button" onClick={onUse}>
          {t('bots.templates.useTemplate', 'Use template…')}
        </Button>
      </div>
      <div
        role="region"
        aria-label={t('bots.templates.aboutTemplate', 'About {{name}}', { name })}
        onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-6 scrollbar-sleek"
      >
        <div className="rounded-lg border border-border bg-muted/40 p-3">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <BotTemplateMascot template={template} className="size-4 rounded" />
            <span className="font-medium text-foreground">{name}</span>
            {t('bots.templates.inItsChat', 'in its chat')}
          </p>
          {(['example1', 'example2'] as const).map((field) => (
            <p key={field} className="mt-1.5 text-sm text-foreground">
              {botTemplateWord(template, field, t)}
            </p>
          ))}
        </div>
        <section>
          <h3 className={SECTION_TITLE}>{t('bots.templates.firstChat', 'What it does first')}</h3>
          <p className="text-sm text-foreground">{botTemplateWord(template, 'firstChat', t)}</p>
        </section>
        {template.needsSetup ? (
          <section className="rounded-md border border-border bg-muted/40 p-3">
            <h3 className={SECTION_TITLE}>{t('bots.templates.needsSetup', 'Needs setup')}</h3>
            <p className="text-sm text-foreground">{botTemplateWord(template, 'needsSetup', t)}</p>
          </section>
        ) : null}
        <section>
          <BotTemplateComesWithHeading />
          <BotTemplateComesWith template={template} />
        </section>
      </div>
    </div>
  )
}
