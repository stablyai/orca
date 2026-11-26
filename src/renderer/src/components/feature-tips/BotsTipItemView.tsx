import type { JSX, RefObject } from 'react'
import { ArrowUp, ChevronDown, ChevronLeft, CornerDownRight, Play, Plus } from 'lucide-react'
import { Trans } from 'react-i18next'
import { BotItemCommentCard } from '@/components/bots/items/BotItemCommentCard'
import { BotItemStatusIcon } from '@/components/bots/items/BotItemStatusIcon'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { cueOn, ITEMS_PAGE } from './bots-tip-timeline'
import { BotsTipScroll, Grow, on } from './bots-tip-pieces'
import { botsTipDemo } from './bots-tip-demo'

/** A translated Activity line whose `<b>` parts are the names, drawn bold as the item view does. */
function Strong({ text }: { text: string }): JSX.Element {
  return <Trans i18n={i18n} defaults={text} components={{ b: <b /> }} />
}

/** Page 2's item view: the question on the item, the owner's answer typed and sent, the item moving on. */
export function BotsTipItemView({
  t: time,
  backLink
}: {
  t: number
  /** The pointer clicks it to go back to the list. */
  backLink: RefObject<HTMLDivElement | null>
}): JSX.Element {
  const t = useTranslate()
  const p = ITEMS_PAGE
  const demo = botsTipDemo(t)
  const safari = demo.item
  const answered = time >= p.answerSent
  const typingAnswer = cueOn(time, p.answerTyping[0], p.answerSent)
  const typing = Math.max(
    0,
    Math.min(1, (time - p.answerTyping[0]) / (p.answerTyping[1] - p.answerTyping[0]))
  )
  const typed = typingAnswer ? demo.answer.slice(0, Math.round(typing * demo.answer.length)) : ''
  return (
    <div className="bt-view" {...on(cueOn(time, ...p.viewOpen))}>
      <div className="bt-vhead">
        <div ref={backLink} className="bt-vback">
          <ChevronLeft className="size-3.5" />
          {t('featureTips.botsTeammate.items', 'Items')}
        </div>
        <h2 className="bt-vtitle">
          <span>#{safari.number}</span> {safari.title}
        </h2>
        <div className="bt-vsub">
          <span className="bt-vstatus">
            <BotItemStatusIcon
              status={time >= p.safariResumed ? 'working' : 'needs_you'}
              live={time >= p.safariResumed}
            />
            {time >= p.safariResumed
              ? t('featureTips.botsTeammate.inProgress', 'In progress')
              : t('featureTips.botsTeammate.needsYou', 'Needs you')}
            <ChevronDown className="size-3" />
          </span>
          <span className="bt-vmeta">
            {t('featureTips.botsTeammate.itemMeta', 'Item {{number}} · {{bot}} · now', {
              number: safari.number,
              bot: demo.bot.name
            })}
          </span>
        </div>
      </div>
      <BotsTipScroll className="bt-vscroll">
        <div>
          <h3 className="bt-vh3">{t('featureTips.botsTeammate.activity', 'Activity')}</h3>
          <div className="bt-rail">
            <div className="bt-act">
              <span className="bt-act-icon">
                <Plus className="size-3" />
              </span>
              <span>
                <Strong
                  text={t(
                    'featureTips.botsTeammate.activityAdded',
                    '<b>{{bot}}</b> added this item',
                    {
                      bot: demo.bot.name
                    }
                  )}
                />
              </span>
            </div>
            <div className="bt-act">
              <span className="bt-act-icon">
                <Play className="size-3" />
              </span>
              <span>
                <Strong
                  text={t(
                    'featureTips.botsTeammate.activityWorker',
                    'Worker started: <b>{{name}}</b>',
                    {
                      name: 'safari-login'
                    }
                  )}
                />
              </span>
            </div>
            <div className="bt-act">
              <span className="bt-act-icon">
                <BotItemStatusIcon status="needs_you" />
              </span>
              <span>
                <Strong
                  text={t(
                    'featureTips.botsTeammate.activityMoved',
                    '<b>{{who}}</b> moved this to <b>{{status}}</b>',
                    {
                      who: demo.bot.name,
                      status: t('featureTips.botsTeammate.needsYou', 'Needs you')
                    }
                  )}
                />
              </span>
            </div>
            <BotItemCommentCard
              bot={demo.bot}
              item={safari}
              entry={answered ? demo.answeredQuestion : demo.openQuestion}
            />
            {/* The card bleeds past the column; the grow's clip makes room for it. */}
            <Grow shown={answered} className="-mx-2 px-2">
              <BotItemCommentCard bot={demo.bot} item={safari} entry={demo.ownerAnswer} />
            </Grow>
            <Grow shown={cueOn(time, p.safariResumed)}>
              <div className="bt-act">
                <span className="bt-act-icon">
                  <BotItemStatusIcon status="working" live />
                </span>
                <span>
                  <Strong
                    text={t(
                      'featureTips.botsTeammate.activityMoved',
                      '<b>{{who}}</b> moved this to <b>{{status}}</b>',
                      {
                        who: t('bots.items.activity.you', 'You'),
                        status: t('featureTips.botsTeammate.inProgress', 'In progress')
                      }
                    )}
                  />
                </span>
              </div>
            </Grow>
          </div>
        </div>
      </BotsTipScroll>
      <div className="bt-cbox">
        <Grow shown={!answered}>
          <div className="bt-answering">
            <CornerDownRight className="size-3 shrink-0" />
            <span>
              {t('featureTips.botsTeammate.answering', 'Answering:')} <b>{demo.question}</b>
            </span>
          </div>
        </Grow>
        <div className="bt-cinput">
          {typed}
          <span className="bt-caret" />
          {typingAnswer ? null : (
            <span className="bt-cph">
              {t('featureTips.botsTeammate.addComment', 'Add a comment…')}
            </span>
          )}
        </div>
        <div className="bt-crow">
          <Plus className="size-3.5" />
          <span className="bt-csend" {...on(typingAnswer)}>
            <ArrowUp className="size-3.5" />
          </span>
        </div>
      </div>
    </div>
  )
}
