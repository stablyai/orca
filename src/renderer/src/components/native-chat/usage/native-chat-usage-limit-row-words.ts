import type { Translate } from '@/i18n/use-translate'
import type { AgentSessionUsageLimitWindow } from '../../../../../shared/agent-session/failures/agent-session-usage-limit'
import type { NativeChatUsageLimitAutoContinueState } from './native-chat-usage-limit-auto-continue-setting'

/** historical: an older turn's limit. unknown: no time to wait for. waiting: before Continue
 *  applies. ready: Continue applies now (the agent has usage again). */
export type UsageLimitPhase = 'historical' | 'unknown' | 'waiting' | 'ready'

export type UsageLimitRowWordsInput = {
  phase: UsageLimitPhase
  /** The provider's own reset has passed. Continue can apply sooner (an account switch), when
   *  the account may still be spent, so only this claims the agent has usage again. */
  usageAgain: boolean
  window: AgentSessionUsageLimitWindow | undefined
  /** The agent's display name, or the translated generic agent. */
  agent: string
  /** The agent's limit sentence without a reset clause, e.g. "Codex hit its session limit." */
  sentence: string
  auto: NativeChatUsageLimitAutoContinueState | null
  /** When Continue applies, in the reader's clock. */
  manualTime: string | null
  /** When Orca continues by itself, when scheduled. */
  autoTime: string | null
  /** The schedule is exactly when Continue applies. */
  sameTime: boolean
}

export type UsageLimitRowWords = {
  title: string
  /** Exact times only, so the line says everything without a hover. */
  subline: string | null
  /** One non-live sentence group a screen reader hears in place of the title and subline. */
  summary: string
}

function limitTitle(
  window: AgentSessionUsageLimitWindow | undefined,
  agent: string,
  t: Translate
): string {
  switch (window) {
    case 'weekly':
    case 'weeklyModel':
      return t(
        'components.native-chat.usageLimitActions.titleWeeklyReached',
        '{{agent}} weekly limit reached',
        { agent }
      )
    case 'credits':
      return t(
        'components.native-chat.usageLimitActions.titleExtraUsageReached',
        '{{agent}} extra usage limit reached',
        { agent }
      )
    case 'session':
    case undefined:
      return t(
        'components.native-chat.usageLimitActions.titleUsageReached',
        '{{agent}} usage limit reached',
        { agent }
      )
  }
}

function accessibleStatus(input: UsageLimitRowWordsInput, t: Translate): string | null {
  const { phase, agent, auto, manualTime, autoTime, sameTime } = input
  if (phase === 'historical') {
    return null
  }
  if (phase === 'unknown') {
    return t('components.native-chat.usageLimitActions.statusUnknown', 'Reset time unknown.')
  }
  if (phase === 'ready' && input.usageAgain) {
    return autoTime
      ? t(
          'components.native-chat.usageLimitActions.statusHasUsageAuto',
          '{{agent}} has usage again. Orca will continue this chat at {{time}}.',
          { agent, time: autoTime }
        )
      : t('components.native-chat.usageLimitActions.statusHasUsage', '{{agent}} has usage again.', {
          agent
        })
  }
  if (phase === 'ready') {
    return autoTime
      ? t(
          'components.native-chat.usageLimitActions.statusCanContinueNowAuto',
          '{{agent}} can continue now. Orca will continue this chat at {{time}}.',
          { agent, time: autoTime }
        )
      : t(
          'components.native-chat.usageLimitActions.statusCanContinueNow',
          '{{agent}} can continue now.',
          { agent }
        )
  }
  if (autoTime && sameTime) {
    return t(
      'components.native-chat.usageLimitAutoContinue.scheduled',
      'Orca will continue this chat at {{time}}.',
      { time: autoTime }
    )
  }
  if (autoTime) {
    return t(
      'components.native-chat.usageLimitActions.statusCanContinueAtAuto',
      'You can continue at {{time}}. Orca will continue this chat at {{autoTime}}.',
      { time: manualTime, autoTime }
    )
  }
  return auto?.kind === 'cancelled'
    ? t(
        'components.native-chat.usageLimitActions.statusCanContinueAtNoAuto',
        "You can continue at {{time}}. Orca won't continue this chat automatically.",
        { time: manualTime }
      )
    : t(
        'components.native-chat.usageLimitActions.statusCanContinueAt',
        'You can continue at {{time}}.',
        { time: manualTime }
      )
}

/** A clock time that wraps as one piece, so "6:04" and "PM" never land on separate lines. */
function unbroken(time: string | null): string | null {
  return time === null ? null : time.replace(/\s/g, ' ')
}

function subline(input: UsageLimitRowWordsInput, t: Translate): string | null {
  const { phase, sameTime } = input
  const manualTime = unbroken(input.manualTime)
  const autoTime = unbroken(input.autoTime)
  if (phase === 'unknown') {
    return t('components.native-chat.usageLimitActions.resetUnknown', 'Reset time unknown')
  }
  if (phase === 'waiting' && autoTime && sameTime) {
    return t('components.native-chat.usageLimitActions.continuesAt', 'Continues at {{time}}', {
      time: autoTime
    })
  }
  if (phase === 'waiting' && manualTime) {
    return t('components.native-chat.usageLimitActions.canContinueAt', 'Can continue at {{time}}', {
      time: manualTime
    })
  }
  if (phase === 'ready' && autoTime) {
    return t(
      'components.native-chat.usageLimitActions.autoContinuesAt',
      'Auto-continues at {{time}}',
      { time: autoTime }
    )
  }
  return null
}

/** What a usage-limit row says: its title, the line under it, and what a screen reader hears. */
export function usageLimitRowWords(
  input: UsageLimitRowWordsInput,
  t: Translate
): UsageLimitRowWords {
  const status = accessibleStatus(input, t)
  return {
    title:
      input.phase !== 'ready'
        ? limitTitle(input.window, input.agent, t)
        : input.usageAgain
          ? t(
              'components.native-chat.usageLimitActions.titleHasUsage',
              '{{agent}} has usage again',
              {
                agent: input.agent
              }
            )
          : t(
              'components.native-chat.usageLimitActions.titleCanContinueNow',
              '{{agent}} can continue now',
              { agent: input.agent }
            ),
    subline: subline(input, t),
    summary: status
      ? t('components.native-chat.usageLimitActions.srSummary', '{{sentence}} {{status}}', {
          sentence: input.sentence,
          status
        })
      : input.sentence
  }
}
