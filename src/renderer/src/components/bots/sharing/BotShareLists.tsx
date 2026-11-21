// The Share dialog's part pages: the items of each part, ticked by default, each opening its text.
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { describeAutomationSchedule } from '../../../../../shared/automations/scheduling/automation-schedules'
import { automationEventKind } from '../../../../../shared/automation-event-triggers'
import { formatUiAutomationScheduleDescriptor } from '../../automations/details/automation-schedule-label'
import { eventLabel } from '../bot-automation-when'
import {
  pickedOf,
  toggled,
  unpackableSkills,
  type BotShareContext,
  type BotShareList
} from './bot-share-pages'
import { MemoryList, SafetyCheckList } from './BotShareFlagPages'
import { Tick } from './BotShareTick'
import { BotShareItem } from './BotShareRows'

function notShared(why: string): string {
  switch (why) {
    case 'webhook':
      return translate('bots.share.webhookNotShared', 'Webhook · not shared')
    case 'command':
      return translate('bots.share.commandNotShared', 'Command · not shared')
    case 'link':
      return translate('bots.share.symlinkNotShared', 'Has a symlink · not shared')
    case 'size':
      return translate('bots.share.tooLargeNotShared', 'Too large · not shared')
    case 'unreadable':
      return translate('bots.share.unreadableNotShared', "Can't be read · not shared")
    default:
      return translate('bots.share.notShared', 'Not shared')
  }
}

export function scheduleWhen(rrule: string): string {
  return formatUiAutomationScheduleDescriptor(describeAutomationSchedule(rrule))
}

export function eventWhen(source: string, event: string): string {
  const kind = automationEventKind(source, event)
  return kind ? eventLabel(kind) : event
}

function SkillsList({ ctx }: { ctx: BotShareContext }): React.JSX.Element {
  const t = useTranslate()
  const all = ctx.candidate.available.skills
  // A second copy of a shared skill's name, in another folder: shown so the owner sees which went.
  const duplicates = ctx.candidate.leftOut.filter(
    (entry) => entry.kind === 'skill' && entry.why === 'duplicate'
  )
  const unpackable = unpackableSkills(ctx.candidate.leftOut)
  const picked = pickedOf(
    ctx.selection.skills,
    all.map((skill) => skill.name)
  )
  return (
    <>
      {all.map((skill) => (
        <BotShareItem
          key={skill.name}
          lead={
            <Tick
              checked={picked.includes(skill.name)}
              label={skill.name}
              onChange={(on) => ctx.select({ skills: toggled(picked, skill.name, on) })}
            />
          }
          title={skill.name}
          detail={skill.description}
          onOpen={() =>
            ctx.open({
              kind: 'part',
              part: `skill:${skill.name}`,
              title: skill.name,
              showNames: true
            })
          }
        />
      ))}
      {duplicates.map((entry) => (
        <BotShareItem
          key={`left:${entry.from ?? entry.name}`}
          off
          lead={<Tick checked={false} label={entry.name} />}
          title={entry.name}
          detail={t('bots.share.duplicateSkill', 'Same name, in {{folder}} · not shared', {
            folder: entry.from ?? ''
          })}
        />
      ))}
      {unpackable.map((entry) => (
        <BotShareItem
          key={`unpackable:${entry.name}`}
          off
          lead={<Tick checked={false} label={entry.name} />}
          title={entry.name}
          detail={notShared(entry.why)}
        />
      ))}
    </>
  )
}

function AutomationsList({ ctx }: { ctx: BotShareContext }): React.JSX.Element {
  const { schedules, eventSuggestions } = ctx.candidate.available
  const pickedSchedules = pickedOf(
    ctx.selection.schedules,
    schedules.map((s) => s.automationId)
  )
  // One automation can start on several events; it is ticked and shown once.
  const events = eventSuggestions.filter(
    (entry, index) =>
      eventSuggestions.findIndex((e) => e.automationId === entry.automationId) === index
  )
  const pickedEvents = pickedOf(
    ctx.selection.eventSuggestions,
    events.map((e) => e.automationId)
  )
  const webhooks = ctx.candidate.leftOut.filter((entry) => entry.kind === 'automation')
  return (
    <>
      {schedules.map((schedule) => (
        <BotShareItem
          key={schedule.automationId}
          lead={
            <Tick
              checked={pickedSchedules.includes(schedule.automationId)}
              label={schedule.name}
              onChange={(on) =>
                ctx.select({ schedules: toggled(pickedSchedules, schedule.automationId, on) })
              }
            />
          }
          title={schedule.name}
          detail={scheduleWhen(schedule.rrule)}
          onOpen={() =>
            ctx.open({
              kind: 'part',
              part: `schedule:${schedule.automationId}`,
              title: schedule.name,
              detail: scheduleWhen(schedule.rrule)
            })
          }
        />
      ))}
      {events.map((event) => (
        <BotShareItem
          key={event.automationId}
          lead={
            <Tick
              checked={pickedEvents.includes(event.automationId)}
              label={event.name}
              onChange={(on) =>
                ctx.select({ eventSuggestions: toggled(pickedEvents, event.automationId, on) })
              }
            />
          }
          title={event.name}
          detail={eventWhen(event.source, event.event)}
          onOpen={() =>
            ctx.open({
              kind: 'part',
              part: `event:${event.automationId}`,
              title: event.name,
              detail: eventWhen(event.source, event.event)
            })
          }
        />
      ))}
      {webhooks.map((entry) => (
        <BotShareItem
          key={`left:${entry.name}`}
          off
          lead={<Tick checked={false} label={entry.name} />}
          title={entry.name}
          detail={notShared(entry.why)}
        />
      ))}
    </>
  )
}

function ToolsList({ ctx }: { ctx: BotShareContext }): React.JSX.Element {
  const all = ctx.candidate.available.tools
  const picked = pickedOf(
    ctx.selection.tools,
    all.map((tool) => tool.name)
  )
  const left = ctx.candidate.leftOut.filter(
    (entry) => entry.kind === 'tool' && entry.why === 'command'
  )
  return (
    <>
      {all.map((tool) => (
        <BotShareItem
          key={tool.name}
          lead={
            <Tick
              checked={picked.includes(tool.name)}
              label={tool.name}
              onChange={(on) => ctx.select({ tools: toggled(picked, tool.name, on) })}
            />
          }
          title={tool.name}
          detail={<span className="font-mono">{tool.url}</span>}
          onOpen={() => ctx.open({ kind: 'part', part: `tool:${tool.name}`, title: tool.name })}
        />
      ))}
      {left.map((entry) => (
        <BotShareItem
          key={`left:${entry.name}`}
          off
          lead={<Tick checked={false} label={entry.name} />}
          title={entry.name}
          detail={notShared(entry.why)}
        />
      ))}
    </>
  )
}

export function BotShareListPage({
  list,
  ctx
}: {
  list: BotShareList
  ctx: BotShareContext
}): React.JSX.Element {
  const t = useTranslate()
  switch (list) {
    case 'skills':
      return <SkillsList ctx={ctx} />
    case 'automations':
      return <AutomationsList ctx={ctx} />
    case 'tools':
      return <ToolsList ctx={ctx} />
    case 'memory':
      return <MemoryList ctx={ctx} />
    case 'check':
      return <SafetyCheckList ctx={ctx} />
    case 'notIncluded':
      return (
        <>
          {ctx.candidate.notIncluded.map((entry) => (
            <BotShareItem
              key={entry}
              title={entry}
              detail={t('bots.share.review.notIncluded', 'Not included')}
            />
          ))}
        </>
      )
    case 'note':
      return (
        <Textarea
          rows={4}
          maxLength={2000}
          value={ctx.note}
          aria-label={t('bots.share.setupNote', 'Setup note')}
          onChange={(event) => ctx.setNote(event.target.value)}
        />
      )
  }
}
