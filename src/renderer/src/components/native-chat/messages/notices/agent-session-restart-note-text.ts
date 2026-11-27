// The host journals restart notes in English, so chats saved earlier and older servers carry the same text.

import type { Translate } from '@/i18n/use-translate'
import {
  AGENT_SESSION_RESTART_CONTINUATION_NOTE as CONTINUED,
  AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE as REFUSED,
  AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE as UNCONFIRMED,
  AGENT_SESSION_RESTART_NOT_CONNECTED_NOTE as NOT_CONNECTED
} from '../../../../../../shared/agent-session/lifecycle/stopping/agent-session-restart-continuation'

const WORDS = new Map<string, (t: Translate) => string>([
  [CONTINUED, (t) => t('components.native-chat.notices.restartContinued', CONTINUED)],
  [REFUSED, (t) => t('components.native-chat.notices.restartContinueRefused', REFUSED)],
  [UNCONFIRMED, (t) => t('components.native-chat.notices.restartContinueUnconfirmed', UNCONFIRMED)],
  [NOT_CONNECTED, (t) => t('components.native-chat.notices.restartNotConnected', NOT_CONNECTED)]
])

/** The restart note in the UI language, or undefined for any other host text. */
export function agentSessionRestartNoteText(text: string, t: Translate): string | undefined {
  return WORDS.get(text)?.(t)
}
