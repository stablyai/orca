import { translate } from '@/i18n/i18n'
import {
  CHAT_NAMING_FAILURE_COPY as EN,
  type ChatNamingFailureCode
} from '../../../../shared/chat-naming-failure-copy'
import type { AgentSessionNamingError } from '../../../../shared/agent-session-wire'

const COPY: Record<ChatNamingFailureCode, () => string> = {
  noName: () => translate('tabHoverCard.namingFailure.errors.noName', EN.noName),
  agentNotRun: () => translate('tabHoverCard.namingFailure.errors.agentNotRun', EN.agentNotRun),
  noAgentAvailable: () =>
    translate('tabHoverCard.namingFailure.errors.noAgentAvailable', EN.noAgentAvailable)
}

function isChatNamingFailureCode(code: unknown): code is ChatNamingFailureCode {
  return typeof code === 'string' && Object.hasOwn(COPY, code)
}

/** Uncoded (agent output, older host) or unknown codes show the host's English message. */
export function nativeChatNamingErrorText(error: AgentSessionNamingError): string {
  return isChatNamingFailureCode(error.messageCode) ? COPY[error.messageCode]() : error.message
}
