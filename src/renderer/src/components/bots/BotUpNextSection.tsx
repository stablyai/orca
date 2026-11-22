import { useEffect, useId, useRef, useState } from 'react'
import { LoaderCircle, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import type { Bot } from '../../../../shared/bot-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import {
  lookedDay,
  suggestionLinkLabel,
  type BotUpNext,
  type Suggestion,
  type UpNextState
} from '../../../../shared/bots/bot-look-around'
import { GitHubIcon } from '../icons/GitHubIcon'
import { LinearIcon } from '../icons/LinearIcon'
import { SlackIcon } from '../icons/SlackIcon'
import { BotPanelSection } from './BotPanelSection'
import { BotRowHoverCard } from './BotPanelRow'
import { useBotPanelFold } from './use-bot-panel-fold'
import { dismissSuggestion, lookNow, startSuggestion } from './bot-up-next-actions'
import { BotLookSteps } from './BotLookSteps'
import { markBotUpNextSeen } from '@/lib/bot-up-next-unseen'
import { useBotHostOffline } from '@/lib/bot-host-views'
import { useNativeChatComposerGlow } from '@/components/native-chat/native-chat-composer-glow'
import { cn } from '@/lib/class-names'
import { botUpNextGlowScope } from './bot-up-next-reveal'

const SOURCE_ICONS = { slack: SlackIcon, linear: LinearIcon, github: GitHubIcon } as const

const LOOKED_TIME = { hour: 'numeric', minute: '2-digit' } as const
const LOOKED_DATE = { month: 'short', day: 'numeric' } as const

/** "Looked 4:12 PM" today, "Looked yesterday 4:12 PM", then "Looked Oct 29". */
export function lookedText(at: number, now = Date.now()): string {
  const day = lookedDay(at, now)
  if (day === 'earlier') {
    return translate('bots.upNext.looked', 'Looked {{time}}', {
      time: uiDateTimeFormat(LOOKED_DATE).format(at)
    })
  }
  const time = uiDateTimeFormat(LOOKED_TIME).format(at)
  return day === 'today'
    ? translate('bots.upNext.looked', 'Looked {{time}}', { time })
    : translate('bots.upNext.lookedYesterday', 'Looked yesterday {{time}}', { time })
}

/** Looking from the click on, before the host's next Activity says the look is running. */
export function useLooking(
  bot: Bot,
  state: UpNextState
): { looking: boolean; lookNowClicked: () => void } {
  const [askedAt, setAskedAt] = useState<number | null>(null)
  if (askedAt !== null && state.running) {
    setAskedAt(null)
  }
  const starting = askedAt !== null && !state.running && (state.lastLookedAt ?? 0) < askedAt
  return {
    looking: state.running || starting,
    lookNowClicked: () => {
      setAskedAt(Date.now())
      void lookNow(bot).then((started) => {
        if (!started) {
          setAskedAt(null)
        }
      })
    }
  }
}

/** Suggestions newer than the owner had seen when this panel opened, marked seen only while shown. */
function useNewSuggestions(
  bot: Bot,
  upNext: BotUpNext,
  shown: boolean
): { newCount: number; seenWhenOpened: number } {
  const { state, items } = upNext
  const [seenWhenOpened] = useState(state.seenAt)
  const hostUnseen = items.some((item) => item.createdAt > state.seenAt)
  const { hostId, id } = bot
  useEffect(() => {
    if (hostUnseen && shown) {
      void markBotUpNextSeen({ hostId, id })
    }
  }, [hostId, id, hostUnseen, items, shown])
  return {
    newCount: items.filter((item) => item.createdAt > seenWhenOpened).length,
    seenWhenOpened
  }
}

/** The header's Look now: a spinner while looking (it opens the steps when there are some), else a
 *  refresh shown on hover or focus whose tooltip says when it last looked. */
function UpNextLookButton({
  looking,
  stepsOpen,
  onToggleSteps,
  lastLookedAt,
  onLookNow
}: {
  looking: boolean
  stepsOpen: boolean
  onToggleSteps: (() => void) | null
  lastLookedAt: number | undefined
  onLookNow: () => void
}): React.JSX.Element {
  const t = useTranslate()
  if (looking) {
    return (
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('bots.upNext.lookingShort', 'Looking around')}
        aria-expanded={onToggleSteps ? stepsOpen : undefined}
        aria-disabled={onToggleSteps ? undefined : true}
        onClick={onToggleSteps ?? undefined}
      >
        <LoaderCircle className="animate-spin" />
      </Button>
    )
  }
  const label = t('bots.upNext.lookNow', 'Look now')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={label} onClick={onLookNow}>
          <RefreshCw />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
        {lastLookedAt ? (
          <span className="block text-muted-foreground">{lookedText(lastLookedAt)}</span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  )
}

// Takes the pointer only while the row shows its actions, so a hidden action is never clicked.
const REVEALED_POINTER =
  "pointer-events-none group-hover/upnext:pointer-events-auto [[class~='group/upnext']:has(:focus-visible)_&]:pointer-events-auto"

function UpNextRow({
  bot,
  item,
  unseen
}: {
  bot: Bot
  item: Suggestion
  unseen: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const Icon = item.source ? SOURCE_ICONS[item.source] : null
  const link = item.link
  // The panel's fieldset already disables Start and Dismiss; this says why, and their variants keep them readable.
  const offline = useBotHostOffline(bot.hostId)
  const offlineId = useId()
  const offlineText = t('bots.upNext.hostOffline', '{{bot}}’s computer is offline', {
    bot: bot.name
  })
  const actions = (
    <span
      className={cn(
        'flex items-center gap-1',
        // Disabled buttons take no pointer, so the group under them takes it and says why.
        offline && `cursor-not-allowed ${REVEALED_POINTER}`
      )}
    >
      <Button
        variant="outline-on-accent"
        size="xs"
        className={cn(!offline && REVEALED_POINTER)}
        disabled={offline}
        aria-describedby={offline ? offlineId : undefined}
        onClick={() => void startSuggestion(bot, item.id)}
      >
        {t('bots.upNext.start', 'Start')}
      </Button>
      <Button
        variant="ghost-on-accent"
        size="icon-xs"
        className={cn(!offline && REVEALED_POINTER)}
        disabled={offline}
        aria-label={t('bots.upNext.dismiss', 'Dismiss')}
        aria-describedby={offline ? offlineId : undefined}
        onClick={() => void dismissSuggestion(bot, item.id)}
      >
        <X />
      </Button>
    </span>
  )
  return (
    // The ring sits on the row, outside the actions' backdrop, so it is never cut off at the end.
    <div className="group/upnext relative flex w-full min-w-0 items-start rounded-sm hover:bg-accent has-focus-visible:bg-accent has-[>button:focus-visible]:ring-1 has-[>button:focus-visible]:ring-ring">
      <BotRowHoverCard
        card={
          <>
            <p className="font-medium">{item.title}</p>
            <p className="mt-1 text-muted-foreground">{item.why}</p>
            {link ? (
              <p className="mt-1.5 text-muted-foreground">{suggestionLinkLabel(link)}</p>
            ) : null}
          </>
        }
      >
        <button
          type="button"
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left focus-visible:outline-none',
            link ? 'cursor-pointer' : 'cursor-default'
          )}
          aria-disabled={link ? undefined : true}
          aria-describedby={offline ? offlineId : undefined}
          onClick={
            link
              ? (event) =>
                  openAppHttpLink(link, {
                    worktreeId: folderWorkspaceKey(bot.folderWorkspaceId),
                    event
                  })
              : undefined
          }
        >
          {/* The slot stays without a source so every title in the panel starts at one edge. */}
          <span className="flex h-5 w-4 shrink-0 items-center justify-center text-muted-foreground">
            {Icon ? <Icon className="size-3.5" /> : null}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-foreground">
            {item.title}
          </span>
          {unseen ? (
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-foreground" />
          ) : null}
        </button>
      </BotRowHoverCard>
      {/* Over the row's end on hover or focus; the fade hides the text it covers. Only the buttons take
          the pointer, so a click on the backdrop around them still opens the row's link. */}
      <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center rounded-r-sm bg-accent pr-1.5 pl-1 text-accent-foreground opacity-0 transition-opacity before:absolute before:inset-y-0 before:right-full before:w-6 before:bg-linear-to-r before:from-transparent before:to-accent group-hover/upnext:opacity-100 [[class~='group/upnext']:has(:focus-visible)_&]:opacity-100">
        {offline ? (
          <Tooltip>
            <TooltipTrigger asChild>{actions}</TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {offlineText}
            </TooltipContent>
          </Tooltip>
        ) : (
          actions
        )}
        {offline ? (
          <span id={offlineId} className="sr-only">
            {offlineText}
          </span>
        ) : null}
      </span>
    </div>
  )
}

/** Up next in a bot's Activity list: what its last look suggests; shown while it has some or is looking. */
export function BotUpNextSection({
  bot,
  upNext
}: {
  bot: Bot
  upNext: BotUpNext
}): React.JSX.Element | null {
  const t = useTranslate()
  const { state, items } = upNext
  const { looking, lookNowClicked } = useLooking(bot, state)
  const [stepsOpen, setStepsOpen] = useState(false)
  const runSessionId = state.running ? state.runSessionId : undefined
  const glowing = useNativeChatComposerGlow(botUpNextGlowScope(bot.id))
  const fold = useBotPanelFold(bot.id, 'suggestions')
  // A reveal shows them even when folded; folded, they stay unseen until opened (the sidebar doesn't count them).
  const open = fold.open || glowing
  const { newCount, seenWhenOpened } = useNewSuggestions(bot, upNext, open)
  const sectionRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (glowing) {
      sectionRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [glowing])
  if (items.length === 0 && !looking) {
    return null
  }
  const lookButton = (
    <UpNextLookButton
      looking={looking}
      stepsOpen={stepsOpen && open}
      onToggleSteps={
        runSessionId
          ? () => {
              // The steps show under the header, so opening them opens a folded section.
              const next = !(stepsOpen && open)
              setStepsOpen(next)
              if (next && !open) {
                fold.onOpenChange(true)
              }
            }
          : null
      }
      lastLookedAt={state.lastLookedAt}
      onLookNow={lookNowClicked}
    />
  )
  return (
    <BotPanelSection
      ref={sectionRef}
      className={cn('rounded-lg', glowing && 'native-chat-composer-glow')}
      title={t('bots.upNext.title', 'Suggestions')}
      fold={{ open, onOpenChange: fold.onOpenChange }}
      // Folded, nothing else says what it hides.
      summary={
        open ? null : (
          <>
            {items.length}
            {newCount > 0 ? (
              <span className="text-foreground">
                {' · '}
                {t('bots.upNext.newCount', '{{count}} new', { count: newCount })}
              </span>
            ) : null}
          </>
        )
      }
      actions={looking ? null : lookButton}
      live={looking ? lookButton : null}
    >
      {runSessionId && stepsOpen ? <BotLookSteps bot={bot} sessionId={runSessionId} /> : null}
      {items.map((item) => (
        <UpNextRow key={item.id} bot={bot} item={item} unseen={item.createdAt > seenWhenOpened} />
      ))}
    </BotPanelSection>
  )
}
