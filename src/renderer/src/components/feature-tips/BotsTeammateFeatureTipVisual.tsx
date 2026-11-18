import { useEffect, useState, type JSX } from 'react'
import { Bookmark, Bug, CircleCheck, Clock, Lightbulb, MessageSquare } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { BotAvatarTile } from '@/components/bots/BotAvatar'
import { BOT_MASCOT_URLS } from '@/components/bots/bot-mascots'
import { usePrefersReducedMotion } from '@/hooks/theme/usePrefersReducedMotion'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { formatUiNarrowDuration } from '@/i18n/relative-time-format'
import { FeatureTipRevealRow } from './ChatUiHereFeatureTipVisual'

type FeedRow = { Icon: LucideIcon; text: string; age: string }

function feedRows(): FeedRow[] {
  return [
    {
      Icon: MessageSquare,
      text: translate('featureTips.botsTeammate.feedAnswered', 'Answered Maya’s question'),
      age: translate('featureTips.botsTeammate.feedJustNow', 'just now')
    },
    {
      Icon: Bug,
      text: translate('featureTips.botsTeammate.feedPickedUp', 'Picked up a new bug'),
      age: formatUiNarrowDuration(4, 'minute')
    },
    {
      Icon: Lightbulb,
      text: translate('featureTips.botsTeammate.feedSuggested', 'Suggested 2 things to look at'),
      age: formatUiNarrowDuration(18, 'minute')
    },
    {
      Icon: Bookmark,
      text: translate('featureTips.botsTeammate.feedRemembered', 'Remembered: keep changes small'),
      age: formatUiNarrowDuration(1, 'hour')
    },
    {
      Icon: CircleCheck,
      text: translate('featureTips.botsTeammate.feedFinished', 'Finished a task for Bob'),
      age: formatUiNarrowDuration(2, 'hour')
    },
    {
      Icon: Clock,
      text: translate('featureTips.botsTeammate.feedCheckedIn', 'Checked in on 3 tasks overnight'),
      age: formatUiNarrowDuration(7, 'hour')
    }
  ]
}

const ROW_MS = 1100
// The full feed holds for two beats, fades, then starts over.
const HOLD_BEATS = 2
const FADE_MS = 600
const RESTART_MS = 400

/** A bot's profile and a feed of what it has been up to, one row at a time. */
export function BotsTeammateFeatureTipVisual(): JSX.Element {
  const t = useTranslate()
  const reducedMotion = usePrefersReducedMotion()
  const rows = feedRows()
  const [shown, setShown] = useState(0)
  const [faded, setFaded] = useState(false)
  const visible = reducedMotion ? rows.length : shown

  useEffect(() => {
    if (reducedMotion) {
      return
    }
    if (faded) {
      const restartId = window.setTimeout(() => {
        setShown(0)
        setFaded(false)
      }, FADE_MS + RESTART_MS)
      return () => window.clearTimeout(restartId)
    }
    const nextId = window.setTimeout(() => {
      if (shown >= rows.length + HOLD_BEATS) {
        setFaded(true)
      } else {
        setShown(shown + 1)
      }
    }, ROW_MS)
    return () => window.clearTimeout(nextId)
  }, [faded, reducedMotion, rows.length, shown])

  return (
    <div
      className="relative flex h-full min-h-[23rem] flex-col items-center justify-center overflow-hidden px-6 py-7"
      aria-hidden="true"
    >
      <div className="flex h-[22rem] w-full max-w-[22rem] flex-col overflow-hidden rounded-xl border border-border/80 bg-chat-canvas text-left tracking-[0.01em] shadow-xs motion-reduce:**:transition-none">
        <div className="flex items-center gap-3 border-b border-border px-[18px] pt-[18px] pb-3.5">
          <BotAvatarTile src={BOT_MASCOT_URLS.A1} fallback="" className="size-12 rounded-xl" />
          <div className="min-w-0">
            <div className="text-sm leading-tight font-semibold text-chat-foreground-strong">
              {t('featureTips.botsTeammate.demoName', 'Scout')}
            </div>
            <div className="text-2xs text-chat-foreground-faint">
              {t('featureTips.botsTeammate.title', 'Your AI teammate')}
            </div>
            <div className="mt-[3px] flex items-center gap-[5px] text-2xs text-chat-foreground">
              <span className="flex text-chat-foreground-faint">
                <LoadingSpinner className="size-[11px]" />
              </span>
              {t('featureTips.botsTeammate.demoWorking', 'Working on this computer')}
            </div>
          </div>
        </div>
        <div className="px-[18px] pt-3 text-2xs font-semibold text-chat-foreground-faint">
          {t('featureTips.botsTeammate.demoActivity', 'Activity')}
        </div>
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden px-[18px] pb-3.5 text-xs transition-opacity duration-500 ease-in-out"
          style={{ opacity: faded && !reducedMotion ? 0 : 1 }}
        >
          {rows.map(({ Icon, text, age }, index) => (
            <FeatureTipRevealRow key={text} on={index < visible}>
              <div className="flex items-center gap-[9px] pt-[9px]">
                <span className="flex size-[22px] shrink-0 items-center justify-center rounded-md border border-border bg-background text-chat-foreground">
                  <Icon className="size-3" />
                </span>
                <span className="min-w-0 flex-1 truncate text-chat-foreground-strong">{text}</span>
                <span className="shrink-0 text-3xs text-chat-foreground-faint">{age}</span>
              </div>
            </FeatureTipRevealRow>
          ))}
        </div>
      </div>
    </div>
  )
}
