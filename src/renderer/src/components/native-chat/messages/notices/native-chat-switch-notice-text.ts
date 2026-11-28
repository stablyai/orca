// The faint lines about what an agent switched mid-chat: Claude's model, or the saved account.

import type { Translate } from '@/i18n/use-translate'
import * as Fallback from '../../../../../../shared/native-chat/transcript/notices/claude-model-fallback'
import { AGENT_ACCOUNT_SWITCH_COPY } from '../../../../../../shared/native-chat/transcript/notices/agent-account-switch-notice'
import type { NativeChatNoticeLook } from '../../../../../../shared/native-chat/transcript/notices/native-chat-notice'

export function nativeChatSwitchNoticeText(
  look: Extract<NativeChatNoticeLook, { kind: 'account-switch' | 'model-fallback' }>,
  t: Translate
): string {
  return look.kind === 'account-switch'
    ? t('components.native-chat.notices.accountSwitch', AGENT_ACCOUNT_SWITCH_COPY, {
        from: look.from,
        to: look.to
      })
    : t(
        'components.native-chat.notices.modelFallback',
        Fallback.CLAUDE_MODEL_FALLBACK_COPY,
        Fallback.claudeModelFallbackLabels(look)
      )
}
