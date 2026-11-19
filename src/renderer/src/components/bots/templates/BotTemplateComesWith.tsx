// What a template's bot comes with, as the template page and New bot both list it: its skills (ticked
// in New bot), schedules made turned off, automations offered in its first chat, and connectors.
import { BookOpen, Clock, Info, Plug, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { BotAppBrandLogo, hasBotAppBrand } from '../apps/BotAppBrandLogo'
import {
  BOT_CONNECTOR_NAMES,
  type BotTemplate,
  type BotTemplateSkill
} from '../../../../../shared/bots/bot-templates'
import {
  BOT_TEMPLATE_SKILL_LINES,
  botTemplateEventParts
} from '../../../../../shared/bots/bot-template-view'

export function BotTemplateComesWithHeading({
  showNote = true
}: {
  showNote?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
      <h3>{t('bots.templates.comesWith', 'Comes with')}</h3>
      {showNote ? (
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
      ) : null}
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

export function BotTemplateComesWith({
  template,
  kept,
  onKeptChange
}: {
  template: BotTemplate
  /** In New bot: the skills left ticked; absent on the template page. */
  kept?: ReadonlySet<BotTemplateSkill>
  onKeptChange?: (skill: BotTemplateSkill, on: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const muted = (text: string) => <span className="text-muted-foreground">{text}</span>
  return (
    <ul>
      {template.skills.map((skill) => (
        <Row
          key={skill}
          mono
          icon={<BookOpen className="size-4" />}
          title={skill}
          line={BOT_TEMPLATE_SKILL_LINES[skill]}
          state={
            kept && onKeptChange ? (
              <Checkbox
                checked={kept.has(skill)}
                onCheckedChange={(on) => onKeptChange(skill, on === true)}
                aria-label={t('bots.templates.keepSkill', 'Add the {{skill}} skill', { skill })}
              />
            ) : null
          }
        />
      ))}
      {template.schedules.map((schedule) => (
        <Row
          key={schedule.id}
          icon={<Clock className="size-4" />}
          title={schedule.when}
          line={schedule.what}
          state={muted(t('bots.templates.stateOff', 'Off'))}
        />
      ))}
      {template.events.map((event) => {
        const parts = botTemplateEventParts(event.name)
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
