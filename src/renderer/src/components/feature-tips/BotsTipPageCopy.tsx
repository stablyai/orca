import { memo, type JSX, type ReactNode } from 'react'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { GitHubIcon } from '@/components/icons/GitHubIcon'
import { LinearIcon } from '@/components/icons/LinearIcon'
import slackLogo from '@/assets/connector-brands/slack.svg'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { BOT_AGENTS } from '../../../../shared/bot-types'
import { finalSentenceStop } from '../../../../shared/text/sentence-joining'
import { FeatureTipRotatingSlot } from './FeatureTipRotatingSlot'

// Product names, never translated.
const BRAND_SLACK = 'Slack'
const BRAND_GITHUB = 'GitHub'
const BRAND_LINEAR = 'Linear'

/** One page's copy: the title, a two-line description and three bold-lead lines. */
function PageCopy({
  title,
  description,
  lines,
  after,
  active
}: {
  /** Only the shown page's title and description name the dialog. */
  active: boolean
  title: string
  description: string
  lines: readonly (readonly [string, ReactNode])[]
  after?: ReactNode
}): JSX.Element {
  // Radix gives every title and description the dialog's ids; an explicit id (none, here) wins, so
  // the pages kept for the transition never name the dialog or repeat its ids.
  const notNaming = active ? {} : { id: undefined }
  // Each part moves on a page switch, one step (40 ms) after the one above it.
  return (
    <DialogHeader className="text-left">
      <div>
        <div className="bt-pg-el">
          <DialogTitle size="display" {...notNaming}>
            {title}
          </DialogTitle>
        </div>
        <div className="bt-pg-el mt-3" data-step="1">
          <DialogDescription className="max-w-2xl" {...notNaming}>
            <span className="block leading-relaxed">{description}</span>
          </DialogDescription>
        </div>
        <ul
          className="bt-pg-el mt-3 flex flex-col gap-1.5 text-sm leading-5 text-muted-foreground"
          data-step="2"
        >
          {lines.map(([lead, rest]) => (
            <li key={lead}>
              <span className="font-semibold text-foreground">{lead}</span> {rest}
            </li>
          ))}
        </ul>
        {after ? (
          <div className="bt-pg-el" data-step="3">
            {after}
          </div>
        ) : null}
      </div>
    </DialogHeader>
  )
}

function AskChip({ children, dark }: { children: ReactNode; dark?: boolean }): JSX.Element {
  return <span className={cn('bt-ask-chip', dark && 'bt-dark-tile')}>{children}</span>
}

/** Page 1's copy. `slotStart` changes each time the page starts, so its rotating names start over. */
export const TeammatePageCopy = memo(function TeammatePageCopy({
  active,
  slotStart
}: {
  active: boolean
  slotStart: number
}): JSX.Element {
  const t = useTranslate()
  const askInLead = t('featureTips.botsTeammate.askIn', 'Anyone can ask it in')
  const askIn = [
    {
      key: 'slack',
      label: BRAND_SLACK,
      icon: (
        <AskChip>
          <img src={slackLogo} alt="" />
        </AskChip>
      )
    },
    {
      key: 'github',
      label: BRAND_GITHUB,
      icon: (
        <AskChip>
          <GitHubIcon />
        </AskChip>
      )
    },
    {
      key: 'linear',
      label: BRAND_LINEAR,
      icon: (
        <AskChip dark>
          <LinearIcon />
        </AskChip>
      )
    }
  ]
  return (
    <PageCopy
      active={active}
      title={t('featureTips.botsTeammate.title', 'Your AI teammate')}
      description={t(
        'featureTips.botsTeammate.description',
        'Ask it in a thread. It runs the work, gets it reviewed and brings back a pull request.'
      )}
      lines={[
        [
          t('featureTips.botsTeammate.alwaysOnLead', 'Always on.'),
          t('featureTips.botsTeammate.alwaysOn', 'Picks up work while you’re away.')
        ],
        [
          t('featureTips.botsTeammate.teamLead', 'Part of the team.'),
          <>
            {askInLead}{' '}
            <FeatureTipRotatingSlot
              // Page 1 shown again starts its names over.
              key={slotStart}
              items={askIn}
              staticLabel={t('featureTips.botsTeammate.askInPlaces', 'Slack, GitHub or Linear')}
            />
            {finalSentenceStop(askInLead)}
          </>
        ],
        [
          t('featureTips.botsTeammate.learnsLead', 'Learns as it goes.'),
          t('featureTips.botsTeammate.learns', 'Remembers what you teach it.')
        ]
      ]}
      after={
        <p className="bt-agents-row">
          <span>{t('featureTips.botsTeammate.agents', 'Works with the agents you use')}</span>
          <span className="bt-agents-marks">
            {BOT_AGENTS.map((agent) => (
              <span key={agent}>
                <AgentIcon agent={agent} size={14} />
              </span>
            ))}
          </span>
        </p>
      }
    />
  )
})

export const ItemsPageCopy = memo(function ItemsPageCopy({
  active
}: {
  active: boolean
}): JSX.Element {
  const t = useTranslate()
  return (
    <PageCopy
      active={active}
      title={t('featureTips.botsTeammate.itemsTitle', 'Its work, in one list')}
      description={t(
        'featureTips.botsTeammate.itemsDescription',
        'Ask for a few things at once. It tracks each one as an item until it’s done.'
      )}
      lines={[
        [
          t('featureTips.botsTeammate.itemsListLead', 'One list of its work.'),
          t('featureTips.botsTeammate.itemsList', 'Every task you hand it.')
        ],
        [
          t('featureTips.botsTeammate.itemsMovesLead', 'Moves it along itself.'),
          t('featureTips.botsTeammate.itemsMoves', 'In progress, then closed.')
        ],
        [
          t('featureTips.botsTeammate.itemsAsksLead', 'Asks you on the item.'),
          t('featureTips.botsTeammate.itemsAsks', 'Reply there and it carries on.')
        ]
      ]}
    />
  )
})

export const GroupPageCopy = memo(function GroupPageCopy({
  active
}: {
  active: boolean
}): JSX.Element {
  const t = useTranslate()
  return (
    <PageCopy
      active={active}
      title={t('featureTips.botsTeammate.groupTitle', 'Bots work together')}
      description={t(
        'featureTips.botsTeammate.groupDescription',
        'Put a few bots in one group chat and give them one goal. They split the work and come back with one answer.'
      )}
      lines={[
        [
          t('featureTips.botsTeammate.groupChatLead', 'Put bots in one chat.'),
          t('featureTips.botsTeammate.groupChat', 'Mention one, or all of them.')
        ],
        [
          t('featureTips.botsTeammate.groupHandLead', 'They hand work to each other.'),
          t('featureTips.botsTeammate.groupHand', 'Each one picks up its part.')
        ],
        [
          t('featureTips.botsTeammate.groupOneLead', 'You get one answer.'),
          t('featureTips.botsTeammate.groupOne', 'With the pull request.')
        ]
      ]}
    />
  )
})
