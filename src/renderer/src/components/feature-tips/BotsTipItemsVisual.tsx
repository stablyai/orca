import { memo, useRef, type JSX } from 'react'
import { ChevronDown, ListTodo, MessagesSquare, Plug, Plus, Square } from 'lucide-react'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { BOT_MASCOT_URLS } from '@/components/bots/bot-mascots'
import { BotItemStatusIcon } from '@/components/bots/items/BotItemStatusIcon'
import { NativeChatBotItemNoteRow } from '@/components/native-chat/bot-items/NativeChatBotItemNoteRow'
import { NativeChatEventRow } from '@/components/native-chat/messages/events/NativeChatEventRow'
import { NativeChatUserBubble } from '@/components/native-chat/messages/rows/NativeChatUserBubble'
import { useTranslate } from '@/i18n/use-translate'
import type { BotItemNoteView } from '../../../../shared/bots/bot-item-note'
import type { BotItemStatus } from '../../../../shared/bots/bot-items'
import {
  cueOn,
  cueStep,
  ITEMS_PAGE,
  itemsGroupCounts,
  itemsSubtitle,
  itemsWorkerBadge
} from './bots-tip-timeline'
import { BotsTipScroll, Grow, on } from './bots-tip-pieces'
import { BotsTipItemView } from './BotsTipItemView'
import { botsTipDemo } from './bots-tip-demo'
import { BotsTipPointer } from './BotsTipPointer'
import { BotsTipWindowTabs } from './BotsTipWindowTabs'

// A model's product name, never translated.
const MODEL_NAME = 'Opus 5.5'

type DemoItem = { uid: string; number: number; title: string }

function note(
  noteId: string,
  by: 'bot' | 'owner',
  item: DemoItem,
  change: 'added' | 'done' | { asked: string } | { comment: string }
): BotItemNoteView {
  const entry = { uid: item.uid, number: item.number, title: item.title }
  if (change === 'added') {
    return {
      noteId,
      by,
      entries: [
        { ...entry, status: 'planned', event: 'made' },
        { ...entry, status: 'working', event: 'status', from: 'planned', to: 'working' }
      ]
    }
  }
  if (change === 'done') {
    return {
      noteId,
      by,
      entries: [{ ...entry, status: 'done', event: 'status', from: 'working', to: 'done' }]
    }
  }
  if ('asked' in change) {
    // An ask is the question as a comment, then the move to Needs you.
    return {
      noteId,
      by,
      entries: [
        { ...entry, status: 'working', event: 'commented', text: change.asked },
        { ...entry, status: 'needs_you', event: 'status', from: 'working', to: 'needs_you' }
      ]
    }
  }
  return {
    noteId,
    by,
    entries: [{ ...entry, status: 'working', event: 'commented', text: change.comment }]
  }
}

function WorkerRow({
  agent,
  badge,
  lead,
  name
}: {
  agent: 'claude' | 'codex'
  badge: 'run' | 'done'
  lead: string
  name: string
}): JSX.Element {
  return (
    <NativeChatEventRow
      icon={<AgentIcon agent={agent} size={14} />}
      badge={badge === 'run' ? 'running' : null}
    >
      {lead} <span className="text-chat-foreground">{name}</span>
    </NativeChatEventRow>
  )
}

function ItemRow({
  item,
  status,
  closed,
  ask,
  rowRef,
  state
}: {
  item: DemoItem
  status: BotItemStatus
  closed?: boolean
  ask?: string
  rowRef?: React.Ref<HTMLDivElement>
  state?: 'q'
}): JSX.Element {
  const t = useTranslate()
  return (
    <div ref={rowRef} className={closed ? 'bt-item bt-closed' : 'bt-item'} data-state={state}>
      <span className="bt-item-glyph">
        <BotItemStatusIcon status={status} live={status === 'working'} />
      </span>
      <span className="bt-item-number">#{item.number}</span>
      <span className="bt-item-text">
        <span className="bt-item-title">{item.title}</span>
        {ask ? <span className="bt-item-ask">{ask}</span> : null}
      </span>
      <span className="bt-item-when">{t('featureTips.botsTeammate.now', 'now')}</span>
    </div>
  )
}

function GroupHead({ label, count }: { label: string; count: number }): JSX.Element {
  return (
    <div className="bt-ghead">
      <ChevronDown className="size-3" />
      {label}
      <span className="bt-gcount">{count}</span>
    </div>
  )
}

/** Page 2: asked for three things, the bot tracks each as an item, works them and asks on one. */
// Memoized: a page off screen keeps its frame and skips the 30 fps renders of the shown page.
export const BotsTipItemsVisual = memo(function BotsTipItemsVisual({
  t: time
}: {
  t: number
}): JSX.Element {
  const t = useTranslate()
  const p = ITEMS_PAGE
  const demo = botsTipDemo(t)
  const csv = {
    uid: 'csv',
    number: 41,
    title: t('featureTips.botsTeammate.itemCsv', 'Fix the CSV export')
  }
  const safari = demo.item
  const docs = {
    uid: 'docs',
    number: 43,
    title: t('featureTips.botsTeammate.itemDocs', 'Update the docs')
  }
  const counts = itemsGroupCounts(time)
  const subtitle = itemsSubtitle(time)
  const started = t('components.native-chat.agentMessage.row.started', 'Started')
  const needsYouRow = useRef<HTMLDivElement>(null)
  const backLink = useRef<HTMLDivElement>(null)
  const pointer = cueStep(time, p.pointer)
  const subtitles = {
    idle: t('featureTips.botsTeammate.idle', 'Idle'),
    one: t('featureTips.botsTeammate.inProgressCount', '{{count}} in progress', { count: 1 }),
    two: t('featureTips.botsTeammate.inProgressCount', '{{count}} in progress', { count: 2 }),
    three: t('featureTips.botsTeammate.inProgressCount', '{{count}} in progress', { count: 3 }),
    needs: t('featureTips.botsTeammate.needsYouCount', '{{count}} needs you', { count: 1 })
  }
  const answered = time >= p.answerSent

  return (
    <div className="bt-stage">
      <div className="bt-cam" data-state={cueStep(time, p.camera)}>
        <div className="bt-win bt-win-items dark">
          <div className="bt-center">
            <BotsTipWindowTabs>
              <img src={BOT_MASCOT_URLS.A1} alt="" className="size-3.5 rounded-[4px]" />
              <span>{demo.bot.name}</span>
            </BotsTipWindowTabs>
            <div className="bt-chat">
              <BotsTipScroll>
                <div className="bt-in flex justify-end" {...on(cueOn(time, p.ask))}>
                  <NativeChatUserBubble className="max-w-[92%]">
                    {t(
                      'featureTips.botsTeammate.itemsAsk',
                      'Fix the CSV export, the Safari login bug and update the docs.'
                    )}
                  </NativeChatUserBubble>
                </div>
                <Grow shown={cueOn(time, p.reply)}>
                  <p className="m-0 text-sm leading-relaxed text-chat-foreground">
                    {t(
                      'featureTips.botsTeammate.itemsReply',
                      'On it. Tracking each one as an item.'
                    )}
                  </p>
                </Grow>
                <div className="flex flex-col gap-1">
                  <Grow shown={cueOn(time, p.csvAdded)}>
                    <NativeChatBotItemNoteRow note={note('csv-added', 'bot', csv, 'added')} />
                  </Grow>
                  <Grow shown={cueOn(time, p.csvWorker)}>
                    <WorkerRow
                      agent="claude"
                      badge={itemsWorkerBadge(time, 'csv')}
                      lead={started}
                      name="csv-export"
                    />
                  </Grow>
                  <Grow shown={cueOn(time, p.safariAdded)}>
                    <NativeChatBotItemNoteRow note={note('safari-added', 'bot', safari, 'added')} />
                  </Grow>
                  <Grow shown={cueOn(time, p.safariWorker)}>
                    <WorkerRow
                      agent="codex"
                      badge={itemsWorkerBadge(time, 'safari')}
                      lead={started}
                      name="safari-login"
                    />
                  </Grow>
                  <Grow shown={cueOn(time, p.docsAdded)}>
                    <NativeChatBotItemNoteRow note={note('docs-added', 'bot', docs, 'added')} />
                  </Grow>
                  <Grow shown={cueOn(time, p.docsWorker)}>
                    <WorkerRow
                      agent="claude"
                      badge={itemsWorkerBadge(time, 'docs')}
                      lead={started}
                      name="update-docs"
                    />
                  </Grow>
                  <Grow shown={cueOn(time, p.csvDone)}>
                    <NativeChatBotItemNoteRow note={note('csv-done', 'bot', csv, 'done')} />
                  </Grow>
                  <Grow shown={cueOn(time, p.docsDone)}>
                    <NativeChatBotItemNoteRow note={note('docs-done', 'bot', docs, 'done')} />
                  </Grow>
                  <Grow shown={cueOn(time, p.safariAsked)}>
                    <NativeChatBotItemNoteRow
                      note={note('safari-asked', 'bot', safari, { asked: demo.question })}
                    />
                  </Grow>
                  <Grow shown={answered}>
                    <NativeChatBotItemNoteRow
                      note={note('safari-answer', 'owner', safari, { comment: demo.answer })}
                    />
                  </Grow>
                  <Grow shown={cueOn(time, p.followUp)}>
                    <WorkerRow
                      agent="codex"
                      badge={itemsWorkerBadge(time, 'follow-up')}
                      lead={t(
                        'components.native-chat.agentMessage.row.followedUp',
                        'Sent follow-up to'
                      )}
                      name="safari-login"
                    />
                  </Grow>
                  <Grow shown={cueOn(time, p.safariDone)}>
                    <NativeChatBotItemNoteRow note={note('safari-done', 'bot', safari, 'done')} />
                  </Grow>
                </div>
              </BotsTipScroll>
              <div className="bt-composer">
                <div className="bt-composer-ph">
                  {t('featureTips.botsTeammate.askAnything', 'Ask anything')}
                </div>
                <div className="bt-composer-row">
                  <Plus className="size-3.5" />
                  <span className="bt-composer-model">{MODEL_NAME}</span>
                  <span className="bt-send">
                    <Square className="size-2.5 fill-current" />
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div className="bt-right">
            <div className="bt-rtabs">
              <span className="bt-rtab bt-on">
                <ListTodo className="size-3.5" />
                {t('featureTips.botsTeammate.items', 'Items')}
                <span className="bt-rtab-count bt-in" {...on(time >= p.csvAdded)}>
                  {cueStep(time, [
                    [0, 1],
                    [p.safariAdded, 2],
                    [p.docsAdded, 3]
                  ] as const)}
                </span>
              </span>
              <span className="bt-rtab">
                <Plug className="size-3.5" />
              </span>
              <span className="bt-rtab">
                <MessagesSquare className="size-3.5" />
              </span>
            </div>
            <div className="bt-rbody">
              <div className="bt-rhead">
                <img src={BOT_MASCOT_URLS.A1} alt="" className="size-9 rounded-[9px]" />
                <div>
                  <div className="bt-rname">{demo.bot.name}</div>
                  <div className="bt-rsub">{subtitles[subtitle]}</div>
                </div>
              </div>
              <div className="bt-ilist">
                <div>
                  <Grow shown={counts.needsYou > 0}>
                    <GroupHead
                      label={t('featureTips.botsTeammate.needsYou', 'Needs you')}
                      count={counts.needsYou}
                    />
                  </Grow>
                  <Grow shown={cueOn(time, p.safariAsked, p.safariResumed)}>
                    <ItemRow
                      item={safari}
                      status="needs_you"
                      ask={demo.question}
                      rowRef={needsYouRow}
                      state="q"
                    />
                  </Grow>
                </div>
                <div>
                  <Grow shown={counts.inProgress > 0}>
                    <GroupHead
                      label={t('featureTips.botsTeammate.inProgress', 'In progress')}
                      count={counts.inProgress}
                    />
                  </Grow>
                  <Grow shown={cueOn(time, p.safariResumed, p.safariDone)}>
                    <ItemRow item={safari} status="working" />
                  </Grow>
                  <Grow shown={cueOn(time, p.csvAdded, p.csvDone)}>
                    <ItemRow item={csv} status="working" />
                  </Grow>
                  <Grow shown={cueOn(time, p.safariAdded, p.safariAsked)}>
                    <ItemRow item={safari} status="working" />
                  </Grow>
                  <Grow shown={cueOn(time, p.docsAdded, p.docsDone)}>
                    <ItemRow item={docs} status="working" />
                  </Grow>
                </div>
                <div>
                  <Grow shown={counts.closed > 0}>
                    <GroupHead
                      label={t('featureTips.botsTeammate.closed', 'Closed')}
                      count={counts.closed}
                    />
                  </Grow>
                  <Grow shown={time >= p.safariDone}>
                    <ItemRow item={safari} status="done" closed />
                  </Grow>
                  <Grow shown={time >= p.docsDone}>
                    <ItemRow item={docs} status="done" closed />
                  </Grow>
                  <Grow shown={time >= p.csvDone}>
                    <ItemRow item={csv} status="done" closed />
                  </Grow>
                </div>
              </div>
              <BotsTipItemView t={time} backLink={backLink} />
            </div>
          </div>
          <BotsTipPointer cue={pointer} targets={{ row: needsYouRow, back: backLink }} />
        </div>
      </div>
    </div>
  )
})
