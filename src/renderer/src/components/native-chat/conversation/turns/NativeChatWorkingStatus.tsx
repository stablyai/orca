import type { BotChatIdentity } from '../../../bots/use-bot-chat-identity'
import { BotAvatarTile } from '../../../bots/BotAvatar'
import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  describeNativeChatTurnStatus,
  NATIVE_CHAT_TURN_STATUS_COPY
} from '../../../../../../shared/native-chat/transcript/turns/native-chat-turn-status'
import type { AgentTurnOutcome } from '../../../../../../shared/agent-status/lifecycle/agent-turn-outcome'
import { useNativeChatElapsedSeconds } from './use-native-chat-elapsed-seconds'

// Literal keys with literal fallbacks: a dynamic key registers no catalog reference.
function turnStatusLabel(
  key: ReturnType<typeof describeNativeChatTurnStatus>['key'],
  duration: string,
  t: Translate = translate
): string {
  switch (key) {
    case 'workedFor':
      return t('components.native-chat.status.workedFor', NATIVE_CHAT_TURN_STATUS_COPY.workedFor, {
        value0: duration
      })
    case 'interruptedAfter':
      return t(
        'components.native-chat.status.interruptedAfter',
        NATIVE_CHAT_TURN_STATUS_COPY.interruptedAfter,
        { value0: duration }
      )
    case 'failedAfter':
      return t(
        'components.native-chat.status.failedAfter',
        NATIVE_CHAT_TURN_STATUS_COPY.failedAfter,
        { value0: duration }
      )
    case 'workingFor':
      return t(
        'components.native-chat.status.workingFor',
        NATIVE_CHAT_TURN_STATUS_COPY.workingFor,
        { value0: duration }
      )
  }
}

/** Run the clock beneath the prompt; after settlement its duration toggles turn details. */
export function NativeChatWorkingStatus({
  bot,
  pendingLabel,
  startedAt,
  workedSeconds,
  verdict,
  expanded = false,
  onToggleExpanded,
  actions
}: {
  bot?: BotChatIdentity | null
  pendingLabel?: string
  startedAt: number | null
  workedSeconds?: number | null
  verdict?: AgentTurnOutcome
  expanded?: boolean
  onToggleExpanded?: () => void
  /** Controls at the line's end; the rule under the status spans them too. */
  actions?: ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const elapsedSeconds = useNativeChatElapsedSeconds(
    startedAt,
    workedSeconds == null && !pendingLabel
  )

  const { key, duration } = describeNativeChatTurnStatus({
    workedSeconds,
    elapsedSeconds,
    verdict
  })
  const label = pendingLabel ?? turnStatusLabel(key, duration, t)
  const detailsLabel = t(
    'components.native-chat.status.toggleDetails',
    NATIVE_CHAT_TURN_STATUS_COPY.toggleDetails
  )
  const identity = bot ? (
    <span role="img" aria-label={bot.name} className="mr-1 shrink-0">
      <BotAvatarTile src={bot.src} fallback={bot.fallback} className="size-6 text-xs" />
    </span>
  ) : null
  // `tabular-nums`: the live clock reflows its own label every second otherwise.
  const className = cn(
    'flex min-h-8 items-center gap-1 text-sm text-chat-foreground-faint tabular-nums',
    !actions && 'border-b border-border'
  )
  const caret =
    workedSeconds != null && onToggleExpanded ? (
      <ChevronRight
        className={cn(
          'size-3.5 transition-transform motion-reduce:transition-none',
          expanded && 'rotate-90'
        )}
        aria-hidden="true"
      />
    ) : null
  const active = workedSeconds == null && !pendingLabel
  const content = (
    <>
      {identity}
      {/* A long name shortens first; the status itself is never cut. */}
      {bot?.showName ? (
        <span className="mr-1 min-w-0 truncate text-chat-foreground">{bot.name}</span>
      ) : null}
      <span className="shrink-0">{label}</span>
      {caret}
    </>
  )
  // Built inline, not in a nested function, so the React Compiler memoizes this component.
  const line =
    workedSeconds != null && onToggleExpanded ? (
      <button
        type="button"
        data-native-chat-turn-status="settled"
        className={cn(
          className,
          'w-full text-left hover:text-chat-foreground-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
        )}
        aria-label={bot ? `${bot.name}, ${label}, ${detailsLabel}` : detailsLabel}
        aria-expanded={expanded}
        onClick={onToggleExpanded}
      >
        {content}
      </button>
    ) : (
      <div
        className={className}
        data-native-chat-turn-status={active ? 'active' : 'settled'}
        // Once settled, screen readers read the visible "Worked for…" text instead.
        aria-label={
          active
            ? [
                bot?.name,
                t(
                  'components.native-chat.status.responding',
                  NATIVE_CHAT_TURN_STATUS_COPY.responding
                )
              ]
                .filter(Boolean)
                .join(', ')
            : undefined
        }
      >
        {content}
      </div>
    )
  return actions ? (
    <div className="flex min-h-8 items-center gap-2 border-b border-border">
      <div className="min-w-0 flex-1">{line}</div>
      {actions}
    </div>
  ) : (
    line
  )
}
