import { translate } from '@/i18n/i18n'
import {
  formatContextTokenCount,
  type NativeChatContextUsage
} from '../../../../shared/native-chat-context-usage'

/** The chat host's answer to `/context` over a terminal session. */
export function formatNativeChatContextUsageAnswer(usage: NativeChatContextUsage | null): string {
  if (!usage) {
    return translate(
      'components.native-chat.context.unavailable',
      'Context usage is not known yet. It becomes available after the agent next responds.'
    )
  }
  // Why: a guessed window would print a plausible but wrong percentage.
  if (usage.windowTokens === null || usage.percentage === null) {
    return translate(
      'components.native-chat.context.used',
      'Context: {{used}} tokens used, estimated from the last response.',
      { used: formatContextTokenCount(usage.usedTokens) }
    )
  }
  return translate(
    'components.native-chat.context.summary',
    'Context: {{used}} / {{window}} tokens ({{percent}}%), estimated from the last response.',
    {
      used: formatContextTokenCount(usage.usedTokens),
      window: formatContextTokenCount(usage.windowTokens),
      percent: String(usage.percentage)
    }
  )
}

/** For a session whose messages will never carry usage, so no later reply helps. */
export function formatNativeChatContextUsageUnreported(): string {
  return translate(
    'components.native-chat.context.unreported',
    'Context usage is not available for this session.'
  )
}
