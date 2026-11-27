// The review of a received link: one line per part, each drilling in to its items and their exact text.
import { Badge } from '@/components/ui/badge'
import { useTranslate } from '@/i18n/use-translate'
import {
  BOT_SHARE_MEMORY_INDEX,
  type BotShareReview
} from '../../../../../shared/bots/bot-share-received'
import { textLineCount } from '../../../../../shared/bots/bot-text-scan'
import { botShareFlagLabel, botShareFlagPage, botShareFlagWhere } from './bot-share-flags'
import type { BotShareFlagSpot } from '../../../../../shared/bots/bot-share-flag-spots'
import { reviewPartFiles, toolHost } from '../../../../../shared/bots/bot-share-review-files'
import {
  reviewAccounts,
  reviewFlagPage,
  type BotShareReviewList,
  type BotShareReviewPage
} from './bot-share-review-parts'
import { eventWhen, scheduleWhen } from './BotShareLists'
import { BotShareFileList } from './BotSharePartView'
import { BotShareFlagIcon, BotShareFlagNote, BotShareItem, BotShareRow } from './BotShareRows'
import { Tick } from './BotShareTick'

export type BotShareReviewContext = {
  review: BotShareReview
  spots: BotShareFlagSpot[]
  open: (page: BotShareReviewPage) => void
  /** The tools the owner ticks, which Create's ticks mirror; null when the review is read-only (a
   *  copy's original), where nothing on any page can be changed. */
  consent: { toolIds: string[]; setToolIds: (ids: string[]) => void } | null
}

export function reviewPageTitle(
  page: BotShareReviewPage,
  t: ReturnType<typeof useTranslate>
): string {
  if (page.kind === 'part') {
    return page.title
  }
  const titles: Record<BotShareReviewList, string> = {
    skills: t('bots.share.skills', 'Skills'),
    automations: t('bots.share.automations', 'Automations'),
    tools: t('bots.share.tools', 'Tools'),
    accounts: t('bots.share.review.accounts', 'Accounts to connect'),
    memory: t('bots.share.memory', 'Memory'),
    check: t('bots.share.safetyCheck', 'Safety check'),
    leftOut: t('bots.share.review.leftOut', 'Left out')
  }
  return titles[page.list]
}

const flagOf = (spots: readonly BotShareFlagSpot[], prefix: string): 'secret' | 'warning' | null =>
  spots.some((spot) => spot.part?.startsWith(prefix))
    ? spots.some((spot) => spot.part?.startsWith(prefix) && spot.flag.kind === 'secret')
      ? 'secret'
      : 'warning'
    : null

export function BotShareReviewOverview({ ctx }: { ctx: BotShareReviewContext }): React.JSX.Element {
  const t = useTranslate()
  const { review, spots } = ctx
  const { bot } = review
  const list = (name: BotShareReviewList) => () => ctx.open({ kind: 'list', list: name })
  const soul = review.files.find((file) => file.path === 'SOUL.md')
  const soulLines = soul?.text ? textLineCount(soul.text) : 0
  const automations = bot.schedules.length + bot.eventSuggestions.length
  const accounts = reviewAccounts(review)
  const count = (value: number) => (value > 0 ? String(value) : t('bots.share.review.none', 'None'))
  return (
    <div>
      <BotShareRow
        title={t('bots.share.soul', 'Soul')}
        value={t('bots.share.lines', '{{count}} lines', { count: soulLines })}
        flag={flagOf(spots, 'soul')}
        onOpen={() =>
          ctx.open({
            kind: 'part',
            part: 'soul',
            title: t('bots.share.soul', 'Soul'),
            detail: `SOUL.md · ${t('bots.share.lines', '{{count}} lines', { count: soulLines })}`
          })
        }
      />
      <BotShareRow
        title={t('bots.share.skills', 'Skills')}
        value={count(bot.skills.length)}
        flag={flagOf(spots, 'skill:')}
        onOpen={bot.skills.length > 0 ? list('skills') : undefined}
      />
      <BotShareRow
        title={t('bots.share.automations', 'Automations')}
        value={count(automations)}
        flag={flagOf(spots, 'schedule:') ?? flagOf(spots, 'event:')}
        onOpen={automations > 0 ? list('automations') : undefined}
      />
      <BotShareRow
        title={t('bots.share.tools', 'Tools')}
        value={count(bot.tools.length)}
        onOpen={bot.tools.length > 0 ? list('tools') : undefined}
      />
      <BotShareRow
        title={t('bots.share.review.accounts', 'Accounts to connect')}
        value={accounts.length > 0 ? accounts.join(', ') : t('bots.share.review.none', 'None')}
        flag={flagOf(spots, 'note')}
        onOpen={accounts.length > 0 || bot.setupNote ? list('accounts') : undefined}
      />
      <BotShareRow
        title={t('bots.share.memory', 'Memory')}
        value={
          bot.memory.length === 0
            ? t('bots.share.review.none', 'None')
            : bot.memory.length === 1
              ? t('bots.share.review.oneNote', '1 note')
              : t('bots.share.review.notes', '{{count}} notes', { count: bot.memory.length })
        }
        flag={flagOf(spots, 'memory:')}
        onOpen={bot.memory.length > 0 ? list('memory') : undefined}
      />
      {review.leftOut.length > 0 ? (
        <BotShareRow
          title={t('bots.share.review.leftOut', 'Left out')}
          value={String(review.leftOut.length)}
          onOpen={list('leftOut')}
        />
      ) : null}
    </div>
  )
}

function AutomationsList({ ctx }: { ctx: BotShareReviewContext }): React.JSX.Element {
  const t = useTranslate()
  const { bot } = ctx.review
  return (
    <>
      {bot.schedules.map((schedule) => (
        <BotShareItem
          key={schedule.id}
          title={schedule.name}
          detail={scheduleWhen(schedule.rrule)}
          trailing={<Badge variant="referenceLabel">{t('bots.share.review.off', 'Off')}</Badge>}
          onOpen={() =>
            ctx.open({
              kind: 'part',
              part: `schedule:${schedule.id}`,
              title: schedule.name,
              detail: scheduleWhen(schedule.rrule)
            })
          }
        />
      ))}
      {bot.eventSuggestions.map((event) => {
        const when = t('bots.share.review.suggested', 'Suggested · {{when}}', {
          when: eventWhen(event.source, event.event).toLowerCase()
        })
        return (
          <BotShareItem
            key={event.id}
            title={event.name}
            detail={when}
            onOpen={() =>
              ctx.open({ kind: 'part', part: `event:${event.id}`, title: event.name, detail: when })
            }
          />
        )
      })}
    </>
  )
}

function ToolsList({ ctx }: { ctx: BotShareReviewContext }): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {ctx.review.bot.tools.map((tool) => {
        const { consent } = ctx
        if (!consent) {
          return <BotShareItem key={tool.id} title={tool.name} detail={toolHost(tool.url)} />
        }
        const label = t('bots.share.review.contact', 'Let it contact {{host}}', {
          host: toolHost(tool.url)
        })
        const { toolIds, setToolIds } = consent
        return (
          <BotShareItem
            key={tool.id}
            lead={
              <Tick
                checked={toolIds.includes(tool.id)}
                label={label}
                onChange={(on) =>
                  setToolIds(on ? [...toolIds, tool.id] : toolIds.filter((id) => id !== tool.id))
                }
              />
            }
            title={label}
            detail={tool.name}
          />
        )
      })}
    </>
  )
}

function AccountsList({ ctx }: { ctx: BotShareReviewContext }): React.JSX.Element {
  const t = useTranslate()
  const note = reviewPartFiles(ctx.review, 'note')
  return (
    <div className="space-y-3">
      <div>
        {reviewAccounts(ctx.review).map((account) => (
          <BotShareItem key={account} title={account} />
        ))}
      </div>
      {note.length > 0 ? (
        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground">
            {t('bots.share.setupNote', 'Setup note')}
          </div>
          <BotShareFileList files={note} showNames={false} />
        </div>
      ) : null}
    </div>
  )
}

function SafetyList({ ctx }: { ctx: BotShareReviewContext }): React.JSX.Element {
  return (
    <>
      {ctx.spots.map((spot) => {
        const page = reviewFlagPage(botShareFlagPage(spot))
        return (
          <BotShareItem
            key={`${spot.flag.where}:${spot.flag.line}:${spot.flag.kind}`}
            lead={<BotShareFlagIcon kind={spot.flag.kind === 'secret' ? 'secret' : 'warning'} />}
            title={botShareFlagLabel(spot.flag.kind)}
            detail={botShareFlagWhere(spot)}
            onOpen={page ? () => ctx.open(page) : undefined}
          />
        )
      })}
    </>
  )
}

export function BotShareReviewList({
  list,
  ctx
}: {
  list: BotShareReviewList
  ctx: BotShareReviewContext
}): React.JSX.Element {
  const t = useTranslate()
  const { bot } = ctx.review
  switch (list) {
    case 'skills':
      return (
        <>
          {bot.skills.map(({ name }) => {
            const spots = ctx.spots.filter((spot) => spot.part === `skill:${name}`)
            const files = reviewPartFiles(ctx.review, `skill:${name}`).length
            return (
              <BotShareItem
                key={name}
                title={name}
                detail={t('bots.share.review.files', '{{count}} files', { count: files })}
                note={spots.map((spot) => (
                  <BotShareFlagNote
                    key={`${spot.flag.where}:${spot.flag.line}:${spot.flag.kind}`}
                    kind={spot.flag.kind === 'secret' ? 'secret' : 'warning'}
                  >
                    {spot.flag.line === null
                      ? botShareFlagLabel(spot.flag.kind)
                      : t('bots.share.review.flagLine', '{{flag}}, line {{line}}', {
                          flag: botShareFlagLabel(spot.flag.kind),
                          line: spot.flag.line
                        })}
                  </BotShareFlagNote>
                ))}
                onOpen={() =>
                  ctx.open({ kind: 'part', part: `skill:${name}`, title: name, showNames: true })
                }
              />
            )
          })}
        </>
      )
    case 'automations':
      return <AutomationsList ctx={ctx} />
    case 'tools':
      return <ToolsList ctx={ctx} />
    case 'accounts':
      return <AccountsList ctx={ctx} />
    case 'memory':
      return (
        <>
          {bot.memory.map(({ topic }) => (
            <BotShareItem
              key={topic}
              title={topic}
              onOpen={() =>
                ctx.open({
                  kind: 'part',
                  part: `memory:${topic}`,
                  title: topic,
                  detail: t('bots.share.memory', 'Memory')
                })
              }
            />
          ))}
          {reviewPartFiles(ctx.review, 'memory-index').length > 0 ? (
            <BotShareItem
              title={BOT_SHARE_MEMORY_INDEX}
              detail={t('bots.share.review.memoryIndex', 'Its memory index, with the shared notes')}
              onOpen={() =>
                ctx.open({
                  kind: 'part',
                  part: 'memory-index',
                  title: BOT_SHARE_MEMORY_INDEX,
                  detail: t(
                    'bots.share.review.memoryIndex',
                    'Its memory index, with the shared notes'
                  )
                })
              }
            />
          ) : null}
        </>
      )
    case 'check':
      return <SafetyList ctx={ctx} />
    case 'leftOut':
      return (
        <>
          {ctx.review.leftOut.map((entry) => (
            <BotShareItem
              key={entry}
              title={entry}
              detail={t('bots.share.review.notIncluded', 'Not included')}
            />
          ))}
        </>
      )
  }
}
