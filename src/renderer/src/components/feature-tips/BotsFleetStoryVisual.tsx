import { useEffect, useRef, type JSX, type ReactNode } from 'react'
import { Check, MousePointer2, Pause, Play, RotateCcw, Sparkles } from 'lucide-react'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { SlackIcon } from '@/components/icons/SlackIcon'
import { BotAvatarTile } from '@/components/bots/BotAvatar'
import { BOT_MASCOT_URLS } from '@/components/bots/bot-mascots'
import { botAgentLabel } from '@/components/bots/bot-presentation'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  FLEET_AGENTS,
  fleetStoryFrame,
  formatAgentClock,
  type FleetStatus
} from './bots-fleet-story-timeline'
import type { FleetStoryPlayback } from './use-bots-fleet-story-playback'

const CARD = 'rounded-lg border border-border/80 bg-chat-canvas p-3 shadow-xs'
// New rows rise in; the stage follows them as they land.
const ENTER =
  'animate-in fade-in-0 slide-in-from-bottom-1 duration-300 ease-out motion-reduce:animate-none'

function Done({ className }: { className?: string }): JSX.Element {
  return (
    <span
      className={cn(
        'flex size-3.5 shrink-0 items-center justify-center rounded-full bg-status-success text-white',
        className
      )}
    >
      <Check className="size-2.5" strokeWidth={3} />
    </span>
  )
}

function Spinner(): JSX.Element {
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center text-chat-foreground-faint">
      <LoadingSpinner className="size-3" />
    </span>
  )
}

function Diff({ added, removed }: { added: number; removed: number }): JSX.Element {
  return (
    <span className="tabular-nums">
      <span className="text-chat-diff-added">+{added}</span>{' '}
      <span className="text-chat-diff-removed">−{removed}</span>
    </span>
  )
}

function Row({ done, children }: { done: boolean; children: ReactNode }): JSX.Element {
  return (
    <div className={cn('flex items-center gap-2 pt-1.5 text-xs', ENTER)}>
      {done ? <Done /> : <Spinner />}
      <span className="flex min-w-0 items-center gap-1.5 text-chat-foreground">{children}</span>
    </div>
  )
}

/** The bots intro story: ask in Slack, the bot runs a fleet of agents, then a PR lands. */
export function BotsFleetStoryVisual({ playback }: { playback: FleetStoryPlayback }): JSX.Element {
  const t = useTranslate()
  const frame = fleetStoryFrame(playback.t)
  const stageRef = useRef<HTMLDivElement>(null)
  const botName = t('featureTips.botsTeammate.demoName', 'Scout')
  const reviewerName = t('featureTips.botsTeammate.demoReviewer', 'Lens')
  const tasks = [
    t('featureTips.botsTeammate.taskDesktop', 'Desktop settings.css'),
    t('featureTips.botsTeammate.taskMobile', 'Mobile settings screen'),
    t('featureTips.botsTeammate.taskScreenshots', 'Update screenshot tests'),
    t('featureTips.botsTeammate.taskTypes', 'Fix 2 type errors')
  ]
  const phases = [
    t('featureTips.botsTeammate.phaseReading', 'Reading files…'),
    t('featureTips.botsTeammate.phaseEditing', 'Editing…'),
    t('featureTips.botsTeammate.phaseTesting', 'Running tests…')
  ]

  // Follow the newest row; a replay starts back at the top.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) {
      return
    }
    stage.scrollTo({
      top: frame.contentKey === 0 ? 0 : stage.scrollHeight,
      behavior: playback.reducedMotion || frame.contentKey === 0 ? 'auto' : 'smooth'
    })
  }, [frame.contentKey, playback.reducedMotion])

  const statusText = (status: FleetStatus): string => {
    switch (status.kind) {
      case 'planning':
        return t('featureTips.botsTeammate.statusPlanning', 'Planning…')
      case 'starting':
        return t('featureTips.botsTeammate.statusStarting', 'Starting {{count}} agents…', {
          count: status.count
        })
      case 'running':
        return status.count > 0
          ? t('featureTips.botsTeammate.statusRunning', '{{count}} agents running…', {
              count: status.count
            })
          : t('featureTips.botsTeammate.statusAgentsDone', 'All agents done')
      case 'review':
        return t('featureTips.botsTeammate.statusReview', 'Asking {{name}} to review…', {
          name: reviewerName
        })
      case 'memory':
        return t('featureTips.botsTeammate.statusMemory', 'Saving what it learned…')
      case 'done':
        return t('featureTips.botsTeammate.statusDone', 'Done')
    }
  }

  return (
    <div className="relative flex h-full min-h-[23rem] flex-col px-6 py-7">
      <p className="sr-only">
        {t(
          'featureTips.botsTeammate.storySummary',
          'You message the bot in Slack from your phone. It runs four coding agents in parallel on your computer, another bot reviews the work, and you get one pull request to review.'
        )}
      </p>
      <div
        ref={stageRef}
        aria-hidden="true"
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-2 scrollbar-sleek overflow-y-auto overscroll-contain text-left tracking-[0.01em] transition-opacity duration-500',
          // Rows scroll under soft top and bottom edges.
          '[mask-image:linear-gradient(to_bottom,transparent,black_14px,black_calc(100%-18px),transparent)]',
          frame.fading && 'opacity-0'
        )}
      >
        {/* Holds the first card off the top edge's fade. */}
        <div className="shrink-0 pt-1" />
        {frame.typing ? (
          <div
            className={cn(
              'flex items-center gap-2 px-1 text-2xs text-chat-foreground-faint',
              ENTER
            )}
          >
            <span className="flex size-4 items-center justify-center rounded-full bg-callout-important text-[9px] font-semibold text-white">
              {t('featureTips.botsTeammate.youInitial', 'Y')}
            </span>
            {t('featureTips.botsTeammate.youTyping', 'You are typing')}
            <span className="flex gap-0.5">
              {[0, 1, 2].map((dot) => (
                <span
                  key={dot}
                  className="size-1 animate-bounce rounded-full bg-chat-foreground-faint"
                  style={{ animationDelay: `${dot * 120}ms` }}
                />
              ))}
            </span>
          </div>
        ) : null}

        {frame.message ? (
          <div className={cn(CARD, 'flex gap-2.5', ENTER)}>
            <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-callout-important text-[11px] font-semibold text-white">
              {t('featureTips.botsTeammate.youInitial', 'Y')}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs">
                <span className="font-semibold text-chat-foreground-strong">
                  {t('featureTips.botsTeammate.you', 'You')}
                </span>
                <span className="flex items-center gap-1 text-2xs text-chat-foreground-faint">
                  <SlackIcon className="size-3" />
                  {t('featureTips.botsTeammate.fromPhone', 'Slack · from your phone')}
                </span>
              </div>
              <p className="mt-0.5 text-xs leading-5 text-chat-foreground-strong">
                <span className="rounded bg-callout-note/15 px-0.5 text-callout-note">
                  @{botName}
                </span>{' '}
                {t(
                  'featureTips.botsTeammate.ask',
                  'ship dark mode for Settings on desktop and mobile'
                )}
              </p>
              {frame.reaction ? (
                <span
                  className={cn(
                    'mt-1 inline-flex items-center gap-1 rounded-full border border-border bg-background px-1.5 py-px text-2xs text-chat-foreground',
                    'animate-in zoom-in-50 fade-in-0 duration-200 motion-reduce:animate-none'
                  )}
                >
                  👀 <b className="font-semibold">{botName}</b>
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {frame.bot ? (
          <div className={cn(CARD, ENTER)}>
            <div className="flex items-center gap-2.5">
              <BotAvatarTile
                src={BOT_MASCOT_URLS.A1}
                fallback=""
                className="size-[30px] rounded-lg"
              />
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-chat-foreground-strong">
                  {botName}
                </div>
                <div className="flex items-center gap-1.5 text-2xs text-chat-foreground">
                  {frame.status.kind === 'done' ? <Done className="size-3" /> : <Spinner />}
                  <span key={frame.status.kind} className="animate-in fade-in-0 duration-200">
                    {statusText(frame.status)}
                  </span>
                </div>
              </div>
              <span className="ml-auto text-3xs text-chat-foreground-faint">
                {t('featureTips.botsTeammate.onThisComputer', 'on this computer')}
              </span>
            </div>

            {frame.agents.some((agent) => agent.shown) ? (
              <div className="mt-2.5 text-3xs font-semibold text-chat-foreground-faint">
                {t('featureTips.botsTeammate.agents', 'Agents')}
              </div>
            ) : null}
            {frame.agents.map((agent, index) =>
              agent.shown ? (
                <div key={index} className={cn('pt-2', ENTER)}>
                  <div className="flex items-center gap-2 text-xs">
                    {agent.done ? <Done /> : <Spinner />}
                    <AgentIcon agent={FLEET_AGENTS[index].agent} size={13} />
                    <span className="shrink-0 font-semibold text-chat-foreground-strong">
                      {botAgentLabel(FLEET_AGENTS[index].agent)}
                    </span>
                    <span className="min-w-0 truncate text-chat-foreground">{tasks[index]}</span>
                    <span className="ml-auto shrink-0 text-3xs tabular-nums text-chat-foreground-faint">
                      {formatAgentClock(agent.clockSeconds)}
                    </span>
                  </div>
                  <div className="ml-[22px] mt-0.5 text-3xs text-chat-foreground-faint">
                    {agent.done ? (
                      <>
                        <Diff
                          added={FLEET_AGENTS[index].added}
                          removed={FLEET_AGENTS[index].removed}
                        />{' '}
                        · {t('featureTips.botsTeammate.testsPass', 'tests pass')}
                      </>
                    ) : (
                      phases[agent.phase]
                    )}
                  </div>
                  {agent.done ? null : (
                    <div className="ml-[22px] mt-1 h-[3px] overflow-hidden rounded-full bg-border">
                      <div
                        className="h-full rounded-full bg-chat-foreground-faint"
                        style={{ width: `${agent.progress * 100}%` }}
                      />
                    </div>
                  )}
                </div>
              ) : null
            )}

            {frame.reviewRow !== 'hidden' ? (
              <Row done={frame.reviewRow === 'done'}>
                <BotAvatarTile src={BOT_MASCOT_URLS.E1} fallback="" className="size-3.5 rounded" />
                <span className="font-semibold text-chat-foreground-strong">{reviewerName}</span>
                {t('featureTips.botsTeammate.reviewedAll', 'reviewed all 4 · 1 fix')}
              </Row>
            ) : null}
            {frame.memoryRow !== 'hidden' ? (
              <Row done={frame.memoryRow === 'done'}>
                <span className="inline-flex items-center gap-1 rounded-full border border-callout-note/50 px-1.5 py-px text-2xs text-callout-note">
                  <Sparkles className="size-2.5" />
                  {t(
                    'featureTips.botsTeammate.remembered',
                    '{{name}} remembered: use color tokens',
                    {
                      name: botName
                    }
                  )}
                </span>
              </Row>
            ) : null}
          </div>
        ) : null}

        {frame.pr ? (
          <div
            className={cn(
              CARD,
              'relative flex items-center gap-2.5',
              'animate-in zoom-in-95 fade-in-0 duration-300 motion-reduce:animate-none'
            )}
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-status-success/15 text-status-success">
              <Check className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs">
                <b className="font-semibold text-chat-foreground-strong">
                  {t('featureTips.botsTeammate.prNumber', 'PR #{{number}}', { number: 485 })}
                </b>{' '}
                <span className="text-chat-foreground">
                  {t('featureTips.botsTeammate.prTitle', 'Dark mode for Settings')}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-3xs text-chat-foreground-faint">
                <Diff added={412} removed={96} />
                <span>·</span>
                <span className="flex gap-0.5">
                  {[0, 1, 2, 3].map((check) => (
                    <span
                      key={check}
                      className={cn(
                        'size-1.5 rounded-full transition-colors duration-200',
                        check < frame.checksPassed ? 'bg-status-success' : 'bg-status-warning/70'
                      )}
                    />
                  ))}
                </span>
                <span className="tabular-nums">{frame.checksPassed}/4</span>
                {frame.reviewed ? (
                  <span className="animate-in fade-in-0 text-status-success duration-300">
                    ·{' '}
                    {t('featureTips.botsTeammate.reviewedBy', 'Reviewed by {{name}}', {
                      name: reviewerName
                    })}
                  </span>
                ) : null}
              </div>
            </div>
            <span className="relative shrink-0">
              <span
                className={cn(
                  'inline-flex h-6 items-center rounded-md bg-primary px-2.5 text-2xs font-medium text-primary-foreground transition-[transform,filter] duration-150',
                  frame.hover && 'brightness-110',
                  frame.click && 'scale-95'
                )}
              >
                {t('featureTips.botsTeammate.review', 'Review')}
              </span>
              {frame.cursor !== 'hidden' ? (
                <MousePointer2
                  className={cn(
                    'pointer-events-none absolute top-1/2 left-1/2 size-4 fill-white text-black drop-shadow transition-transform duration-700 ease-out',
                    frame.cursor === 'away' ? 'translate-x-10 translate-y-10' : 'translate-x-0',
                    frame.click && 'scale-90'
                  )}
                />
              ) : null}
            </span>
          </div>
        ) : null}
        <div className="shrink-0 pb-2" />
      </div>

      {playback.reducedMotion ? null : (
        <button
          type="button"
          onClick={playback.finished ? playback.replay : playback.togglePause}
          className="absolute right-3 bottom-2 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {playback.finished ? (
            <>
              <RotateCcw className="size-3" />
              {t('featureTips.botsTeammate.replay', 'Replay')}
            </>
          ) : playback.playing ? (
            <>
              <Pause className="size-3" />
              {t('featureTips.botsTeammate.pause', 'Pause')}
            </>
          ) : (
            <>
              <Play className="size-3" />
              {t('featureTips.botsTeammate.play', 'Play')}
            </>
          )}
        </button>
      )}
    </div>
  )
}
