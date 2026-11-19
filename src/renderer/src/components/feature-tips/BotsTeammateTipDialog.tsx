import { useEffect, useLayoutEffect, useRef, type JSX, type ReactNode } from 'react'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { BOT_MASCOT_URLS } from '@/components/bots/bot-mascots'
import { GitHubIcon } from '@/components/icons/GitHubIcon'
import { LinearIcon } from '@/components/icons/LinearIcon'
import slackLogo from '@/assets/connector-brands/slack.svg'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { forceLayoutReflow } from '@/lib/overlay-interaction/force-layout-reflow'
import type { FeatureTip } from '../../../../shared/feature-education/feature-tips'
import { BOT_AGENTS } from '../../../../shared/bot-types'
import { getLocalizedFeatureTipCopy } from './feature-tip-localized-copy'
import { FeatureTipDialogFrame } from './FeatureTipDialogFrame'
import { FeatureTipRotatingSlot } from './FeatureTipRotatingSlot'
import { BotsTipGroupVisual } from './BotsTipGroupVisual'
import { BotsTipMascots } from './BotsTipMascots'
import { BotsTipPageNav } from './BotsTipPageNav'
import { BotsTipSlackVisual } from './BotsTipSlackVisual'
import { BOTS_TIP_PAGE_COUNT, mascotPawTapping } from './bots-tip-timeline'
import { useBotsTipPlayback } from './use-bots-tip-playback'
import './bots-tip.css'

// Product names, never translated.
const BRAND_SLACK = 'Slack'
const BRAND_GITHUB = 'GitHub'
const BRAND_LINEAR = 'Linear'

/** One page's copy: the title, a two-line description and three bold-lead lines. */
function PageCopy({
  title,
  description,
  lines,
  after
}: {
  title: string
  description: string
  lines: readonly (readonly [string, ReactNode])[]
  after?: ReactNode
}): JSX.Element {
  // Each part moves on a page switch, one step (40 ms) after the one above it.
  return (
    <DialogHeader className="text-left">
      <div>
        <div className="bt-pg-el">
          <DialogTitle size="display">{title}</DialogTitle>
        </div>
        <div className="bt-pg-el mt-3" data-step="1">
          <DialogDescription className="max-w-2xl">
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

export function BotsTeammateTipDialog({
  open,
  tip,
  onOpenChange,
  onPrimaryAction
}: {
  open: boolean
  tip: FeatureTip
  /** Closing by ×, Esc or a click outside marks the tip seen. */
  onOpenChange: (open: boolean) => void
  onPrimaryAction: () => void
}): JSX.Element {
  const t = useTranslate()
  const primaryButtonRef = useRef<HTMLButtonElement>(null)
  const playback = useBotsTipPlayback(open)
  const { page, visit, pageStarts, pageTimes, reducedMotion, goTo } = playback

  // The incoming copy starts 4px low with no transition, then eases up into place.
  const copyLayers = useRef<(HTMLDivElement | null)[]>([])
  useLayoutEffect(() => {
    const incoming = copyLayers.current[page]
    if (!incoming || visit === 0) {
      return
    }
    incoming.classList.add('bt-pre')
    forceLayoutReflow(incoming)
    incoming.classList.remove('bt-pre')
  }, [page, visit])

  // A page that starts again shows its first frame at once instead of animating back to it.
  const snapping = !reducedMotion && playback.t === 0 ? page : null

  useEffect(() => {
    if (!open) {
      return
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowRight' && page < BOTS_TIP_PAGE_COUNT - 1) {
        goTo(page + 1)
      } else if (event.key === 'ArrowLeft' && page > 0) {
        goTo(page - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, page, goTo])

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
  const pages = [
    <PageCopy
      key="teammate"
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
            {t('featureTips.botsTeammate.askIn', 'Anyone can ask it in')}{' '}
            <FeatureTipRotatingSlot
              // Page 1 shown again starts its names over.
              key={pageStarts[0]}
              items={askIn}
              staticLabel={t('featureTips.botsTeammate.askInPlaces', 'Slack, GitHub or Linear')}
            />
            .
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
    />,
    <PageCopy
      key="group"
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
  ]
  const visuals = [
    <BotsTipSlackVisual key="slack" t={pageTimes[0]!} />,
    <BotsTipGroupVisual key="group" t={pageTimes[1]!} />
  ]

  return (
    <FeatureTipDialogFrame
      open={open}
      onOpenChange={onOpenChange}
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        // Why: longer locales overflow the fixed frame; scrolling to the button would hide the title.
        primaryButtonRef.current?.focus({ preventScroll: true })
      }}
      wide
      scope="bots"
      copyClassName="justify-center"
      outside={
        <BotsTipMascots
          open={open}
          reducedMotion={reducedMotion}
          tapping={page === 0 && mascotPawTapping(pageTimes[0]!)}
        />
      }
      visual={
        // The story is drawn for the eye; the copy says it for screen readers.
        <div className="bt-visual-stack" aria-hidden inert>
          {visuals.map((visual, index) => (
            <div
              key={visual.key}
              className={cn(
                'bt-layer',
                index === page && 'bt-cur',
                index === snapping && 'bt-snap'
              )}
            >
              {visual}
            </div>
          ))}
        </div>
      }
    >
      <div className="bt-eyebrow">
        <span className="bt-new">{t('featureTips.eyebrowNew', 'New')}</span>
        {t('featureTips.botsTeammate.product', 'Orca Bots')}
      </div>
      <div className="bt-copy-stack">
        {pages.map((copy, index) => (
          <div
            key={copy.key}
            ref={(node) => {
              copyLayers.current[index] = node
            }}
            className={cn('bt-layer', index === page && 'bt-cur')}
            aria-hidden={index !== page}
          >
            {copy}
          </div>
        ))}
      </div>
      <div className="mt-8 flex items-center gap-2">
        <BotsTipPageNav page={page} progress={playback.progress} onPage={goTo} />
        <span className="flex-1" />
        <Button ref={primaryButtonRef} onClick={onPrimaryAction}>
          <span className="bt-faces" aria-hidden>
            <img src={BOT_MASCOT_URLS.A1} alt="" />
            <img src={BOT_MASCOT_URLS.E1} alt="" />
            <img src={BOT_MASCOT_URLS.B1} alt="" />
          </span>
          {getLocalizedFeatureTipCopy(tip).ctaLabel}
        </Button>
      </div>
    </FeatureTipDialogFrame>
  )
}
