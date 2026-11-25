// The Share dialog's contents: one inset row per part, each with a quiet value, opening its page.
import {
  BookOpen,
  Brain,
  Check,
  Clock,
  Minus,
  NotebookPen,
  Shield,
  Smile,
  ChevronRight,
  TriangleAlert,
  Wrench
} from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { SettingsInsetGroup } from '../settings-view/BotSettingsRows'
import { botShareCheckSummary } from './bot-share-flags'
import {
  allMemory,
  pickedOf,
  type BotShareContext,
  type BotShareList,
  type BotSharePage
} from './bot-share-pages'

function firstWords(note: string): string | null {
  const words = note.trim().split(/\s+/).filter(Boolean)
  return words.length === 0 ? null : `${words.slice(0, 5).join(' ')}${words.length > 5 ? '…' : ''}`
}

export function pageTitle(page: BotSharePage, t: ReturnType<typeof useTranslate>): string {
  if (page.kind === 'part') {
    return page.title
  }
  const titles: Record<BotShareList, string> = {
    skills: t('bots.share.skills', 'Skills'),
    automations: t('bots.share.automations', 'Automations'),
    tools: t('bots.share.tools', 'Tools'),
    memory: t('bots.share.memory', 'Memory'),
    note: t('bots.share.setupNote', 'Setup note'),
    check: t('bots.share.safetyCheck', 'Safety check'),
    notIncluded: t('bots.share.notIncluded', 'Not included')
  }
  return titles[page.list]
}

type Tone = 'muted' | 'secret' | 'warning'

/** One part: icon, title, a quiet value, and a chevron when it opens a page; "None" when empty. */
function PartRow({
  icon,
  title,
  value,
  tone = 'muted',
  empty,
  trailing,
  onOpen
}: {
  icon: React.ReactNode
  title: string
  value?: React.ReactNode
  tone?: Tone
  empty?: boolean
  trailing?: React.ReactNode
  onOpen?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const opens = Boolean(onOpen) && !empty
  return (
    <div
      data-row-icon=""
      role={opens ? 'button' : undefined}
      tabIndex={opens ? 0 : undefined}
      onClick={opens ? onOpen : undefined}
      onKeyDown={(event) => {
        if (opens && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          onOpen?.()
        }
      }}
      className={cn(
        'flex min-h-11 items-center gap-2.5 py-2 pr-2.5 pl-3 text-sm outline-none',
        opens && 'cursor-pointer transition-colors hover:bg-accent/60 focus-visible:bg-accent/60'
      )}
    >
      <span className="flex w-4 shrink-0 justify-center text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span
        className={cn(
          'shrink-0 leading-[18px] whitespace-nowrap',
          empty ? 'text-muted-foreground' : 'font-medium'
        )}
      >
        {title}
      </span>
      <span
        className={cn(
          'flex min-w-0 flex-1 items-center justify-end gap-1.5 truncate text-xs',
          tone === 'secret'
            ? 'text-destructive'
            : tone === 'warning'
              ? 'text-status-warning-text'
              : 'text-muted-foreground'
        )}
      >
        {empty ? t('bots.share.none', 'None') : value}
      </span>
      {trailing ? (
        // A switch on the row acts on its own; it never opens the page.
        <span
          className="flex"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {trailing}
        </span>
      ) : null}
      {trailing && !opens ? null : (
        <ChevronRight
          className={cn('size-3.5 shrink-0 text-muted-foreground', !opens && 'invisible')}
        />
      )}
    </div>
  )
}

/** All picked lists the names; some picked reads "2 of 3". */
function partValue(
  picked: readonly string[],
  all: number,
  t: ReturnType<typeof useTranslate>
): string {
  return picked.length === all && all > 0
    ? picked.join(', ')
    : t('bots.share.countOf', '{{picked}} of {{all}}', { picked: picked.length, all })
}

export function BotShareOverview({ ctx }: { ctx: BotShareContext }): React.JSX.Element {
  const t = useTranslate()
  const { candidate, selection } = ctx
  const { available, leftOut } = candidate
  const list = (name: BotShareList) => () => ctx.open({ kind: 'list', list: name })
  const skills = pickedOf(
    selection.skills,
    available.skills.map((s) => s.name)
  )
  const events = available.eventSuggestions.filter(
    (entry, index, all) => all.findIndex((e) => e.automationId === entry.automationId) === index
  )
  const automationNames = [
    ...available.schedules
      .filter((s) => pickedOf(selection.schedules, [s.automationId]).length > 0)
      .map((s) => s.name),
    ...events
      .filter((e) => pickedOf(selection.eventSuggestions, [e.automationId]).length > 0)
      .map((e) => e.name)
  ]
  const webhooks = leftOut.filter((entry) => entry.kind === 'automation').length
  const automations = available.schedules.length + events.length
  const tools = pickedOf(
    selection.tools,
    available.tools.map((tool) => tool.name)
  )
  const commands = leftOut.filter(
    (entry) => entry.kind === 'tool' && entry.why === 'command'
  ).length
  const memoryOn = selection.memory !== undefined
  const memorySecret = ctx.spots.some(
    (spot) => spot.flag.kind === 'secret' && spot.part?.startsWith('memory:')
  )
  const secrets = ctx.spots.filter((spot) => spot.flag.kind === 'secret').length
  const lines =
    available.soulLines === 1
      ? t('bots.share.oneLine', '1 line')
      : t('bots.share.lines', '{{count}} lines', { count: available.soulLines })
  return (
    <>
      <SettingsInsetGroup>
        <PartRow
          icon={<Smile />}
          title={t('bots.share.soul', 'Soul')}
          value={lines}
          onOpen={() =>
            ctx.open({
              kind: 'part',
              part: 'soul',
              title: t('bots.share.soul', 'Soul'),
              detail: `SOUL.md · ${lines}`
            })
          }
        />
        <PartRow
          icon={<BookOpen />}
          title={t('bots.share.skills', 'Skills')}
          empty={available.skills.length === 0}
          value={partValue(skills, available.skills.length, t)}
          onOpen={list('skills')}
        />
        <PartRow
          icon={<Clock />}
          title={t('bots.share.automations', 'Automations')}
          empty={automations + webhooks === 0}
          value={partValue(automationNames, automations + webhooks, t)}
          onOpen={list('automations')}
        />
        <PartRow
          icon={<Wrench />}
          title={t('bots.share.tools', 'Tools')}
          empty={available.tools.length + commands === 0}
          value={partValue(tools, available.tools.length + commands, t)}
          onOpen={list('tools')}
        />
        <PartRow
          icon={<Brain />}
          title={t('bots.share.includeMemory', 'Include memory')}
          tone={memorySecret ? 'secret' : 'muted'}
          value={
            memoryOn
              ? t('bots.share.countOf', '{{picked}} of {{all}}', {
                  picked: selection.memory?.length ?? 0,
                  all: available.memory.length
                })
              : null
          }
          trailing={
            <Switch
              checked={memoryOn}
              disabled={available.memory.length === 0}
              aria-label={t('bots.share.includeMemory', 'Include memory')}
              onCheckedChange={(on) => {
                // On sends every file; the list that opens is for leaving some out.
                ctx.select({ memory: on ? allMemory(available.memory) : undefined })
                if (on) {
                  ctx.open({ kind: 'list', list: 'memory' })
                }
              }}
            />
          }
          onOpen={memoryOn ? list('memory') : undefined}
        />
        {candidate.notIncluded.length > 0 ? (
          <PartRow
            icon={<Minus />}
            title={t('bots.share.notIncluded', 'Not included')}
            value={String(candidate.notIncluded.length)}
            onOpen={list('notIncluded')}
          />
        ) : null}
      </SettingsInsetGroup>
      <SettingsInsetGroup>
        <PartRow
          icon={<NotebookPen />}
          title={t('bots.share.setupNote', 'Setup note')}
          value={firstWords(ctx.note) ?? t('bots.share.add', 'Add')}
          onOpen={list('note')}
        />
        <PartRow
          icon={<Shield className={cn(secrets > 0 && 'text-destructive')} />}
          title={t('bots.share.safetyCheck', 'Safety check')}
          tone={secrets > 0 ? 'secret' : ctx.spots.length > 0 ? 'warning' : 'muted'}
          value={
            <>
              {secrets > 0 ? null : ctx.spots.length > 0 ? (
                <TriangleAlert className="size-3 shrink-0" />
              ) : (
                <Check className="size-3 shrink-0" />
              )}
              {botShareCheckSummary(ctx.spots)}
            </>
          }
          onOpen={ctx.spots.length > 0 ? list('check') : undefined}
        />
      </SettingsInsetGroup>
    </>
  )
}

/** The same rows while the candidate builds: titles, with a bar for each value. */
export function BotShareOverviewSkeleton(): React.JSX.Element {
  const t = useTranslate()
  const bar = (width: number) => (
    <span className="inline-block h-[9px] rounded bg-foreground/10" style={{ width }} />
  )
  return (
    <>
      <SettingsInsetGroup>
        <PartRow icon={<Smile />} title={t('bots.share.soul', 'Soul')} value={bar(50)} />
        <PartRow icon={<BookOpen />} title={t('bots.share.skills', 'Skills')} value={bar(80)} />
        <PartRow
          icon={<Clock />}
          title={t('bots.share.automations', 'Automations')}
          value={bar(110)}
        />
        <PartRow icon={<Wrench />} title={t('bots.share.tools', 'Tools')} value={bar(100)} />
        <PartRow
          icon={<Brain />}
          title={t('bots.share.includeMemory', 'Include memory')}
          trailing={<Switch checked={false} disabled aria-hidden />}
        />
      </SettingsInsetGroup>
      <SettingsInsetGroup>
        <PartRow
          icon={<NotebookPen />}
          title={t('bots.share.setupNote', 'Setup note')}
          value={bar(30)}
        />
        <PartRow
          icon={<Shield />}
          title={t('bots.share.safetyCheck', 'Safety check')}
          value={bar(70)}
        />
      </SettingsInsetGroup>
    </>
  )
}
