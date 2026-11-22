// New bot from a template: one row of chips, one per kind of part it comes with. A chip opens the parts
// of that kind; skills switch off there. A host on an older Orca takes the instructions only, said in one line.
import { useState } from 'react'
import { BookOpen, Clock, Plug, Zap } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { BotAppBrandLogo, hasBotAppBrand } from './apps/BotAppBrandLogo'
import {
  BOT_CONNECTOR_NAMES,
  type BotTemplate,
  type BotTemplateSkill
} from '../../../../shared/bots/bot-templates'
import type { BotPackageConnector } from '../../../../shared/bots/bot-package'
import {
  BOT_TEMPLATE_SKILL_LINES,
  botTemplateEventParts
} from '../../../../shared/bots/bot-template-view'

const appIcon = (kind: BotPackageConnector) =>
  hasBotAppBrand(kind) ? (
    <BotAppBrandLogo app={{ id: kind }} size="xs" />
  ) : (
    <Plug className="size-3.5" />
  )

function PartsChip({
  label,
  icon,
  tone = 'plain',
  boundary,
  children
}: {
  label: string
  icon: React.ReactNode
  /** Kept inside New bot's content column, so a narrow dialog never cuts it off. */
  boundary: Element | null
  /** `partial`: some parts switched off. `needs`: apps still to set up. */
  tone?: 'plain' | 'partial' | 'needs'
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-[13px] border px-2.5 text-xs font-medium whitespace-nowrap transition-colors outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-3.5 [&_svg]:shrink-0',
            tone === 'needs'
              ? 'border-status-warning/45 text-status-warning-text'
              : 'border-border text-foreground',
            tone === 'partial' && 'text-muted-foreground'
          )}
        >
          <span aria-hidden className="flex items-center">
            {icon}
          </span>
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={label}
        className="w-72 max-w-[calc(100vw-2rem)]"
        collisionBoundary={boundary}
        collisionPadding={20}
      >
        <ul className="p-1">{children}</ul>
      </PopoverContent>
    </Popover>
  )
}

function PartRow({
  icon,
  title,
  line,
  mono,
  state
}: {
  icon: React.ReactNode
  title: string
  line?: string | null
  mono?: boolean
  state: React.ReactNode
}): React.JSX.Element {
  return (
    <li className="flex items-start gap-2.5 rounded-sm px-2 py-1.5">
      <span aria-hidden className="mt-0.5 shrink-0 text-muted-foreground [&_svg]:size-3.5">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn('block text-sm text-foreground', mono && 'font-mono text-xs leading-5')}
        >
          {title}
        </span>
        {line ? <span className="block text-xs text-muted-foreground">{line}</span> : null}
      </span>
      <span className="flex shrink-0 items-center pt-0.5 text-xs whitespace-nowrap text-muted-foreground">
        {state}
      </span>
    </li>
  )
}

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
  /** Omitted when the Computer field already explains the block. */
  hostLabel?: string
  kept: ReadonlySet<BotTemplateSkill>
  onKeptChange: (skill: BotTemplateSkill, on: boolean) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const [row, setRow] = useState<HTMLDivElement | null>(null)
  if (!packages) {
    if (!hostLabel) {
      return null
    }
    const note = t(
      'bots.new.parts.olderHost',
      '{{host}} needs an Orca update to add skills and schedules',
      { host: hostLabel }
    )
    return (
      <p className="truncate text-xs text-muted-foreground" title={note}>
        {note}
      </p>
    )
  }
  const { skills, events, schedules, connectors } = template
  if (!skills.length && !events.length && !schedules.length && !connectors.length) {
    return null
  }
  const keptCount = skills.filter((skill) => kept.has(skill)).length
  const firstApp = connectors[0]
  const boundary = row?.closest('[role="dialog"]') ?? null
  return (
    <div ref={setRow} className="flex flex-wrap gap-1.5">
      {skills.length ? (
        <PartsChip
          boundary={boundary}
          icon={<BookOpen />}
          tone={keptCount < skills.length ? 'partial' : 'plain'}
          label={
            keptCount < skills.length
              ? t('bots.new.parts.skillsKept', '{{kept}}/{{count}} skills', {
                  kept: keptCount,
                  count: skills.length,
                  defaultValue_one: '{{kept}}/{{count}} skill'
                })
              : t('bots.new.parts.skills', '{{count}} skills', {
                  count: skills.length,
                  defaultValue_one: '{{count}} skill'
                })
          }
        >
          {skills.map((skill) => (
            <PartRow
              key={skill}
              mono
              icon={<BookOpen />}
              title={skill}
              line={BOT_TEMPLATE_SKILL_LINES[skill]}
              state={
                <Switch
                  size="compact"
                  checked={kept.has(skill)}
                  onCheckedChange={(on) => onKeptChange(skill, on)}
                  aria-label={t('bots.templates.keepSkill', 'Add the {{skill}} skill', { skill })}
                />
              }
            />
          ))}
        </PartsChip>
      ) : null}
      {events.length ? (
        <PartsChip
          boundary={boundary}
          icon={<Zap />}
          label={t('bots.new.parts.automations', '{{count}} automations', {
            count: events.length,
            defaultValue_one: '{{count}} automation'
          })}
        >
          {events.map((event) => {
            const parts = botTemplateEventParts(event.name)
            return (
              <PartRow
                key={event.id}
                icon={<Zap />}
                title={parts.trigger}
                line={parts.action}
                state={t('bots.templates.stateFirstChat', 'First chat')}
              />
            )
          })}
        </PartsChip>
      ) : null}
      {schedules.length ? (
        <PartsChip
          boundary={boundary}
          icon={<Clock />}
          label={t('bots.new.parts.schedules', '{{count}} schedules', {
            count: schedules.length,
            defaultValue_one: '{{count}} schedule'
          })}
        >
          {schedules.map((schedule) => (
            <PartRow
              key={schedule.id}
              icon={<Clock />}
              title={schedule.when}
              line={schedule.what}
              state={t('bots.templates.stateOff', 'Off')}
            />
          ))}
        </PartsChip>
      ) : null}
      {/* A new bot has no apps yet; each is set up per computer in its first chat, so none connect here. */}
      {firstApp ? (
        <PartsChip
          boundary={boundary}
          tone="needs"
          icon={connectors.length === 1 ? appIcon(firstApp) : <Plug />}
          label={
            connectors.length === 1
              ? t('bots.new.parts.needsApp', 'Needs {{app}}', {
                  app: BOT_CONNECTOR_NAMES[firstApp]
                })
              : t('bots.new.parts.needsApps', 'Needs {{count}} apps', {
                  count: connectors.length,
                  defaultValue_one: 'Needs {{count}} app'
                })
          }
        >
          {connectors.map((kind) => (
            <PartRow
              key={kind}
              icon={appIcon(kind)}
              title={BOT_CONNECTOR_NAMES[kind]}
              state={t('bots.new.parts.setUpInFirstChat', 'Set up in first chat')}
            />
          ))}
        </PartsChip>
      ) : null}
    </div>
  )
}
