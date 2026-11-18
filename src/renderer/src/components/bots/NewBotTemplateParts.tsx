// New bot from a template: what the bot comes with, its skills ticked to keep. A host on an older Orca
// makes the bot from its instructions only, and says so here before Create.
import { useTranslate } from '@/i18n/use-translate'
import type { BotTemplate, BotTemplateSkill } from '../../../../shared/bots/bot-templates'
import { BotTemplateComesWith } from './templates/BotTemplateComesWith'

export function NewBotTemplateParts({
  template,
  packages,
  hostLabel,
  kept,
  onKeptChange
}: {
  template: BotTemplate
  /** The picked computer applies template packages (`bots.templates.v2`). */
  packages: boolean
  hostLabel: string
  kept: ReadonlySet<BotTemplateSkill>
  onKeptChange: (skill: BotTemplateSkill, on: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <section className="border-t border-border pt-4">
      <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">
        {t('bots.templates.comesWith', 'Comes with')}
      </h3>
      {packages ? (
        <BotTemplateComesWith template={template} kept={kept} onKeptChange={onKeptChange} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {t(
            'bots.templates.olderHost',
            '{{host}} runs an older Orca, so this template’s skills and schedules won’t be added. Update Orca there to get them, or create the bot with just its instructions.',
            { host: hostLabel }
          )}
        </p>
      )}
    </section>
  )
}
