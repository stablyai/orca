// What a template's bot comes with, as the template page lists it: its skills, schedules made turned off,
// automations offered in its first chat, and connectors.
import { BookOpen, Clock, Info, Plug, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { BotAppBrandLogo, hasBotAppBrand } from '../apps/BotAppBrandLogo'
import { BOT_CONNECTOR_NAMES, type BotTemplate } from '../../../../../shared/bots/bot-templates'
import { BOT_TEMPLATE_SKILL_LINES } from '../../../../../shared/bots/bot-template-view'
import {
  botTemplateEventWords,
  botTemplateSkillName,
  botTemplateText
} from '../../../../../shared/bots/bot-template-text'

export function BotTemplateComesWithHeading(): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
      <h3>{t('bots.templates.comesWith', 'Comes with')}</h3>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('bots.templates.comesWithHelp', 'About template schedules and setup')}
          >
            <Info className="size-3.5" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4} className="max-w-xs">
          {t(
            'bots.templates.comesWithNote',
            'Schedules start turned off. Automations and connectors are set up in its first chat, once you pick the repo or channel.'
          )}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

function Row({
  icon,
  title,
  line,
  state,
  mono
}: {
  icon: React.ReactNode
  title: string
  line?: string | null
  state?: React.ReactNode
  mono?: boolean
}): React.JSX.Element {
  return (
    <li className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-3 border-b border-border/60 py-2.5 last:border-b-0">
      <span className="mt-0.5 text-muted-foreground" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0">
        <span className={cn('block text-sm text-foreground', mono && 'font-mono text-xs')}>
          {title}
        </span>
        {line ? <span className="block text-xs text-muted-foreground">{line}</span> : null}
      </span>
      {state ? <span className="text-xs">{state}</span> : null}
    </li>
  )
}

export function BotTemplateComesWith({ template }: { template: BotTemplate }): React.JSX.Element {
  const t = useTranslate()
  const muted = (text: string) => <span className="text-muted-foreground">{text}</span>
  return (
    <ul>
      {template.skills.map((skill) => {
        const name = botTemplateSkillName(skill, t)
        return (
          <Row
            key={skill}
            // The folder name reads as code; a translated name reads as words.
            mono={name === skill}
            icon={<BookOpen className="size-4" />}
            title={name}
            line={botTemplateText(BOT_TEMPLATE_SKILL_LINES[skill], t)}
          />
        )
      })}
      {template.schedules.map((schedule) => (
        <Row
          key={schedule.id}
          icon={<Clock className="size-4" />}
          title={botTemplateText(schedule.when, t)}
          line={botTemplateText(schedule.what, t)}
          state={muted(t('bots.templates.stateOff', 'Off'))}
        />
      ))}
      {template.events.map((event) => {
        const parts = botTemplateEventWords(event.name, t)
        return (
          <Row
            key={event.id}
            icon={<Zap className="size-4" />}
            title={parts.trigger}
            line={parts.action}
            state={muted(t('bots.templates.stateFirstChat', 'First chat'))}
          />
        )
      })}
      {template.connectors.map((kind) => (
        <Row
          key={kind}
          icon={
            hasBotAppBrand(kind) ? (
              <BotAppBrandLogo app={{ id: kind }} size="xs" />
            ) : (
              <Plug className="size-4" />
            )
          }
          title={BOT_CONNECTOR_NAMES[kind]}
          // A new bot has no connectors yet: each is the one to act on, so it isn't muted.
          state={
            <span className="text-foreground">
              {t('bots.templates.stateNotConnected', 'Not connected')}
            </span>
          }
        />
      ))}
    </ul>
  )
}
