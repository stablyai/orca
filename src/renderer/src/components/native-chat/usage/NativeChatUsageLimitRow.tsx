import { useLayoutEffect, useRef, useState } from 'react'
import { Check, Clock, Gauge, Loader2, MessageSquarePlus } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store'
import { validResetAt } from '@/components/status-bar/usage/usage-reset-caption'
import type { NativeChatTextBlock } from '../../../../../shared/native-chat/native-chat-types'
import type { AgentSessionFailureFact } from '../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureSentence } from '../../../../../shared/agent-session/failures/agent-session-failure-words'
import { formatUsageLimitResetClock } from '../../../../../shared/agent-session/failures/agent-session-usage-limit'
import { sayAgentSessionFailureTranslated } from '../messages/notices/agent-session-failure-words-text'
import { useNativeChatOrcaStopView } from '../messages/notices/native-chat-orca-stop-context'
import { ProviderFrameRow } from '../messages/diagnostics/NativeChatProviderDetails'
import { NativeChatInterruptedContinueButton } from './NativeChatInterruptedContinue'
import { useNativeChatUsageLimitActions } from './NativeChatUsageLimitActions'
import {
  openUsageLimitContinueSetting,
  turnOnUsageLimitAutoContinue,
  type NativeChatUsageLimitAutoContinueState
} from './native-chat-usage-limit-auto-continue-setting'
import { useUsageLimitContinueClock } from './use-usage-limit-continue-clock'
import { USAGE_LIMIT_COPY_CAP, usageLimitCopyText } from './native-chat-usage-limit-copy-text'
import { usageLimitRowWords, type UsageLimitPhase } from './native-chat-usage-limit-row-words'
import {
  restoreUsageLimitFocus,
  UsageLimitFocusSlot,
  UsageLimitMoreMenu,
  UsageLimitToolButton,
  type UsageLimitMoreItem,
  type UsageLimitPendingFocus
} from './NativeChatUsageLimitRowControls'

// Narrow rows stack: words on top at full width, tools on a right-aligned line below. Continue is
// wider than the icon tools, so its rows stack sooner.
const STACK = {
  tools: {
    row: '@max-[280px]:flex-wrap',
    lead: '@max-[280px]:basis-full',
    tools: '@max-[280px]:ml-auto'
  },
  continue: {
    row: '@max-[340px]:flex-wrap',
    lead: '@max-[340px]:basis-full',
    tools: '@max-[340px]:ml-auto'
  }
} as const

const AUTO_CONTINUE_OFF: NativeChatUsageLimitAutoContinueState = { kind: 'off' }

type ScheduledAutoContinue = Extract<NativeChatUsageLimitAutoContinueState, { kind: 'scheduled' }>

async function copyUsageLimitError(
  block: NativeChatTextBlock,
  summary: string,
  detail: string | undefined,
  t: Translate
): Promise<void> {
  const frame = block.providerFrame
  const text = usageLimitCopyText({
    sentence: summary,
    detail,
    ...(frame
      ? {
          frame: {
            provider: frame.provider,
            summary: frame.kind,
            head: frame.payload.head,
            ...(frame.payload.truncated
              ? {
                  truncatedNote: t(
                    'components.native-chat.notices.truncatedResponse',
                    'Provider response truncated (original size: {{bytes}} bytes).',
                    { bytes: frame.payload.byteLength }
                  )
                }
              : {})
          }
        }
      : {}),
    copyNote: t(
      'components.native-chat.usageLimitActions.copyTruncated',
      'Copied text was shortened to fit {{count}} characters.',
      { count: USAGE_LIMIT_COPY_CAP }
    )
  })
  try {
    await window.api.ui.writeClipboardText(text)
  } catch {
    toast.error(
      t('components.native-chat.usageLimitActions.copyFailed', "Couldn't copy the error.")
    )
  }
}

function AutoContinueTool({
  auto,
  autoTime
}: {
  auto: NativeChatUsageLimitAutoContinueState
  autoTime: string | null
}): React.JSX.Element {
  const t = useTranslate()
  const settingOn = useAppStore(
    (state) => state.settings?.nativeChatAutoContinueAfterUsageLimit === true
  )
  if (auto.kind === 'scheduled') {
    return (
      <UsageLimitToolButton
        label={t(
          'components.native-chat.usageLimitActions.cancelAt',
          "Don't continue at {{time}}",
          { time: autoTime }
        )}
        pressed
        disabled={auto.cancelDisabled}
        onClick={auto.cancel}
      >
        <Clock className="size-3.5" />
      </UsageLimitToolButton>
    )
  }
  // Off with the setting off: the clock turns it on here, and the host schedules this chat. The
  // host also says off for a chat it can't continue while the setting is on; that opens Settings.
  if (auto.kind === 'off' && !settingOn) {
    return (
      <UsageLimitToolButton
        label={t(
          'components.native-chat.usageLimitActions.turnOnAutoContinue',
          'Continue automatically when limits reset'
        )}
        pressed={false}
        onClick={turnOnUsageLimitAutoContinue}
      >
        <Clock className="size-3.5" />
      </UsageLimitToolButton>
    )
  }
  return (
    <UsageLimitToolButton
      label={
        auto.kind === 'cancelled'
          ? t(
              'components.native-chat.usageLimitActions.wontContinue',
              "Won't continue automatically"
            )
          : t(
              'components.native-chat.usageLimitActions.autoContinueSettings',
              'Auto-continue settings'
            )
      }
      onClick={openUsageLimitContinueSetting}
    >
      <Clock className="size-3.5" />
    </UsageLimitToolButton>
  )
}

/** A usage-limit notice as one row: what limit, when the chat can go on, and icon tools. */
export function NativeChatUsageLimitRow({
  block,
  failure,
  agentName,
  detail,
  active
}: {
  block: NativeChatTextBlock
  failure: AgentSessionFailureFact
  agentName?: string
  /** The failure's diagnostic text, when it adds to the row's words. */
  detail?: string
  /** This row is the chat's current usage-limit stop, so its recovery actions apply. */
  active: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const view = useNativeChatOrcaStopView()
  const actions = useNativeChatUsageLimitActions()
  const limit = failure.kind === 'usageLimitReached' ? failure.usageLimit : undefined
  // When Continue applies: the provider's reset, or earlier once the chat moved accounts.
  const manualAt = active
    ? (validResetAt(view.usageLimitContinueAt ?? limit?.resetsAt) ?? undefined)
    : undefined
  // Historical rows pass no time, so they never schedule a wake.
  const passed = useUsageLimitContinueClock(manualAt)
  // Continue can apply before the provider's reset (an account switch); only the reset itself
  // says the agent has usage again. Its own wake runs only when it is a different moment.
  const resetAt = active ? (validResetAt(limit?.resetsAt) ?? undefined) : undefined
  const resetIsManual = resetAt === manualAt
  const resetPassedAlone = useUsageLimitContinueClock(resetIsManual ? undefined : resetAt)
  const usageAgain = resetIsManual ? passed : resetPassedAlone
  const auto = active ? (view.usageLimitAutoContinue ?? null) : null
  // This machine's setting configures only its own chats: a remote host offers just a published
  // schedule to cancel, and a local host without the feature offers nothing.
  const localSetting = active && !view.remoteHost && view.usageLimitAutoContinueUnavailable !== true
  const scheduled: ScheduledAutoContinue | null = auto?.kind === 'scheduled' ? auto : null
  const clockAuto: NativeChatUsageLimitAutoContinueState | null = view.remoteHost
    ? scheduled
    : localSetting
      ? (auto ?? AUTO_CONTINUE_OFF)
      : null
  const phase: UsageLimitPhase = !active
    ? 'historical'
    : manualAt === undefined
      ? 'unknown'
      : passed
        ? 'ready'
        : 'waiting'
  const autoTime = scheduled ? formatUsageLimitResetClock(scheduled.resetsAt) : null
  const sameTime = scheduled !== null && scheduled.resetsAt === manualAt
  const words = usageLimitRowWords(
    {
      phase,
      usageAgain,
      window: limit?.window,
      agent: agentName ?? sayAgentSessionFailureTranslated('theAgent', {}),
      // The cause and window, without a reset clause: the status sentences carry the times.
      sentence: agentSessionFailureSentence(
        failure,
        'row',
        { agentName },
        sayAgentSessionFailureTranslated
      ),
      auto,
      manualTime: manualAt === undefined ? null : formatUsageLimitResetClock(manualAt),
      autoTime,
      sameTime
    },
    t
  )

  const [detailsShown, setDetailsShown] = useState(false)
  const hasDetails = Boolean(block.providerFrame || detail)
  const moreRef = useRef<HTMLButtonElement>(null)
  const slotRef = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef<UsageLimitPendingFocus>(null)
  const slotKey = phase === 'ready' ? 'continue' : phase === 'historical' ? 'none' : 'tools'
  useLayoutEffect(() => {
    const pending = pendingFocus.current
    pendingFocus.current = null
    if (pending !== null) {
      restoreUsageLimitFocus(pending === 'slot' ? slotRef.current : null, moreRef.current)
    }
  }, [slotKey, detailsShown])

  const moreItems: UsageLimitMoreItem[] = [
    ...(hasDetails
      ? [
          {
            key: 'details',
            label: detailsShown
              ? t('components.native-chat.usageLimitActions.hideDetails', 'Hide details')
              : t('components.native-chat.usageLimitActions.showDetails', 'Show details'),
            onSelect: () => setDetailsShown((shown) => !shown)
          }
        ]
      : []),
    {
      key: 'copy',
      label: t('components.native-chat.usageLimitActions.copyError', 'Copy error'),
      onSelect: () => void copyUsageLimitError(block, words.summary, detail, t)
    },
    // The pressed clock cancels when both times agree; otherwise More names the later one.
    ...(scheduled && (phase === 'ready' || (phase === 'waiting' && !sameTime))
      ? [
          {
            key: 'cancel',
            label: t(
              'components.native-chat.usageLimitActions.cancelAt',
              "Don't continue at {{time}}",
              { time: autoTime }
            ),
            disabled: scheduled.cancelDisabled,
            onSelect: scheduled.cancel
          }
        ]
      : []),
    ...(localSetting && (phase === 'waiting' || phase === 'ready')
      ? [
          {
            key: 'settings',
            label: t(
              'components.native-chat.usageLimitActions.settingsMenu',
              'Auto-continue settings…'
            ),
            onSelect: openUsageLimitContinueSetting
          }
        ]
      : [])
  ]

  const stack = slotKey === 'continue' ? STACK.continue : STACK.tools
  return (
    <div className="@container rounded-md border border-border bg-muted/20 text-sm">
      <div
        className={cn('flex min-h-10 items-start gap-x-2 gap-y-1 py-1.5 pl-2.5 pr-1.5', stack.row)}
      >
        <div className={cn('flex min-w-0 flex-1 items-start gap-2 pt-1', stack.lead)}>
          {phase === 'ready' ? (
            <Check
              aria-hidden="true"
              className="mt-px size-4 shrink-0 text-status-success @max-[260px]:hidden"
            />
          ) : (
            <Gauge
              aria-hidden="true"
              className="mt-px size-4 shrink-0 text-chat-warning @max-[260px]:hidden"
            />
          )}
          <div
            aria-hidden="true"
            className="min-w-0 flex-1 leading-tight @min-[400px]:flex @min-[400px]:items-baseline @min-[400px]:gap-1.5"
          >
            <span className="line-clamp-2 font-semibold text-chat-foreground [overflow-wrap:normal] @min-[400px]:shrink-0">
              {words.title}
            </span>
            {words.subline ? (
              <span className="block min-w-0 text-xs [overflow-wrap:anywhere] text-chat-foreground-faint tabular-nums">
                {words.subline}
              </span>
            ) : null}
          </div>
        </div>
        <p className="sr-only">{words.summary}</p>
        <div ref={slotRef} className={cn('flex shrink-0 items-center gap-0.5', stack.tools)}>
          {slotKey === 'none' ? null : (
            <UsageLimitFocusSlot key={slotKey} pendingFocus={pendingFocus}>
              {slotKey === 'tools' ? (
                <>
                  {actions?.account ? <span className="contents">{actions.account}</span> : null}
                  {actions?.handOff ? (
                    <UsageLimitToolButton
                      label={t(
                        'components.native-chat.usageLimitActions.handOff',
                        'Hand off to another agent'
                      )}
                      disabled={actions.disabled}
                      busy={actions.preparing}
                      onClick={actions.handOff}
                    >
                      {actions.preparing ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <MessageSquarePlus className="size-3.5" />
                      )}
                    </UsageLimitToolButton>
                  ) : null}
                  {phase === 'waiting' && clockAuto ? (
                    // Locally, a host still loading or yet to publish offers the setting as "off".
                    <AutoContinueTool auto={clockAuto} autoTime={autoTime} />
                  ) : null}
                </>
              ) : (
                <NativeChatInterruptedContinueButton
                  onContinue={view.continueUsageLimit}
                  disabled={view.usageLimitContinueDisabled}
                  explanation={t(
                    'components.native-chat.interruptedContinue.usageLimitExplanation',
                    'Asks the agent to continue where it left off. Use it once the limit resets.'
                  )}
                />
              )}
            </UsageLimitFocusSlot>
          )}
          <UsageLimitMoreMenu triggerRef={moreRef} items={moreItems} />
        </div>
      </div>
      {hasDetails && detailsShown ? (
        <div className="px-1.5 pb-1.5">
          <ProviderFrameRow
            block={block}
            detail={detail}
            summary={t('components.native-chat.notices.details', 'Details')}
            bodyClassName="[overflow-wrap:anywhere]"
            open
            onOpenChange={(open, details) => {
              if (open) {
                return
              }
              if (details.contains(document.activeElement)) {
                pendingFocus.current = 'more'
              }
              setDetailsShown(false)
            }}
          />
        </div>
      ) : null}
    </div>
  )
}
