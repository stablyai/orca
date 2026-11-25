import {
  botFailureText,
  readBotFailure,
  type BotFailure
} from '../../../../shared/bots/bot-failure-copy'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { translate } from '@/i18n/i18n'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import { refusedForOlderHostPurposeLimit } from '../../../../shared/bots/bot-proposal'
import { UNSAVED_DRAFTS_REMOVAL_REFUSAL } from '../../../../shared/worktree/removal/removal'
import {
  agentSessionRefusalFailure,
  readAgentSessionErrorRefusal
} from '../../../../shared/agent-session/failures/agent-session-write-failure'
import { agentSessionStartRefusalParts } from '../../../../shared/agent-session/failures/agent-session-refusal-notice'
import { agentSessionWriteNoticeText } from '@/components/native-chat/messages/notices/agent-session-write-notice-text'
import { structuredAgentSessionTargetPlace } from '@/components/native-chat/pane/ownership/use-structured-agent-session-host-label'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { useAppStore } from '@/store'
import { GoogleAccountsNeedHostUpdate } from './google/set-bot-google'
import type { AgentSessionRefusalReference } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'

/** Bots name their agent as the product does ("Claude Code"); the shared catalog's "Claude" stays app-wide. */
export function botAgentLabel(agent: TerminalAgent): string {
  return agent === 'claude'
    ? translate('bots.new.agentClaude', 'Claude Code')
    : getAgentLabel(agent)
}

const IS_WINDOWS = navigator.userAgent.includes('Windows')

/** A bot's home, shown from the user's home rather than as a full path. */
export function botFolderDisplay(folder: string, windows = IS_WINDOWS): string {
  return windows ? `%USERPROFILE%\\.orca\\bots\\${folder}` : `~/.orca/bots/${folder}`
}

/** A bot chat its agent refused, as native chat words it. Its host calls itself this computer, so
 *  `hostName` names the runtime the bot runs on as this reader does. */
export function botRefusalText(refusal: AgentSessionRefusalReference, hostName?: string): string {
  return agentSessionWriteNoticeText(
    agentSessionStartRefusalParts(agentSessionRefusalFailure(refusal), hostName ? { hostName } : {})
  )
}

/** The bot failure code the host sent with an error; null when it sent none. */
export function botFailureOf(error: unknown): BotFailure | null {
  const data = error instanceof RuntimeRpcCallError ? error.response.error.data : undefined
  return readBotFailure(
    typeof data === 'object' && data !== null && 'botFailure' in data ? data.botFailure : undefined
  )
}

/** A bot failure the host sent by code, in this reader's language; null when it sent none. */
export function botFailureMessage(error: unknown): string | null {
  const failure = botFailureOf(error)
  return failure ? botFailureText(failure, translate) : null
}

/** The host's own words for a refusal, translated when it sent a code. */
export function botErrorText(error: unknown): string {
  return botFailureMessage(error) ?? (error instanceof Error ? error.message : String(error))
}

// A sentence for people: capital first, end punctuation, and no snake_case code inside.
const HOST_SENTENCE = /^[A-Z][^\n]*\s[^\n]*[.!?]$/
const CODE_TOKEN = /\b[a-z0-9]+_[a-z0-9_]+\b/

/** An invalid_argument refusal the host worded for people: its reason beats a generic retry, which
 *  would fail the same way. Codes and schema errors stay behind the generic copy. */
function hostSentenceOf(error: unknown): string | null {
  if (!(error instanceof RuntimeRpcCallError) || error.code !== 'invalid_argument') {
    return null
  }
  const text = error.message.trim()
  // A paired server's words call itself "this computer", which here would mean the Mac.
  const remote = error.target?.kind === 'environment' && /this computer/i.test(text)
  return HOST_SENTENCE.test(text) && !CODE_TOKEN.test(text) && !remote ? text : null
}

/** A create's refusal; an older host that checks the earlier purpose limit says so. */
export function botCreateErrorMessage(error: unknown, purpose: string | undefined): string {
  return error instanceof RuntimeRpcCallError &&
    refusedForOlderHostPurposeLimit(error.code, error.message, purpose)
    ? translate(
        'bots.errors.purposeTooLongForHost',
        "Orca on that computer takes up to 200 characters for what it's for. Shorten it, or update Orca there."
      )
    : botErrorMessage(error)
}

export function botErrorMessage(error: unknown): string {
  const coded = botFailureMessage(error)
  if (coded) {
    return coded
  }
  if (error instanceof GoogleAccountsNeedHostUpdate) {
    return error.message
  }
  // Runtime errors carry the controller's code as their message.
  if (error instanceof Error && error.message === 'bot_name_taken') {
    return translate('bots.errors.nameTaken', 'Another bot already has that name.')
  }
  if (error instanceof Error && error.message === 'bot_avatar_home_unreadable') {
    return translate(
      'bots.errors.avatarHomeUnreadable',
      "Couldn't read the saved picture. Choose it again."
    )
  }
  if (error instanceof Error && error.message === 'bot_folder_not_owned') {
    return translate('bots.errors.folderNotOwned', "Couldn't verify this bot's folder.")
  }
  if (error instanceof Error && error.message === 'bot_avatar_invalid') {
    return translate(
      'bots.errors.avatarInvalid',
      'That picture could not be used. Pick a PNG or JPG image.'
    )
  }
  if (error instanceof Error && error.message === UNSAVED_DRAFTS_REMOVAL_REFUSAL) {
    return translate(
      'bots.errors.unsavedDrafts',
      'Its folder has unsaved editor changes. Save or close them, then delete again.'
    )
  }
  const refusal = readAgentSessionErrorRefusal(error)
  if (refusal) {
    const host = error instanceof RuntimeRpcCallError ? error.target : undefined
    return botRefusalText(
      refusal,
      host && structuredAgentSessionTargetPlace(useAppStore.getState(), host, translate)
    )
  }
  const reason = hostSentenceOf(error)
  if (reason) {
    return reason
  }
  return translate('bots.errors.generic', 'Something went wrong. Try again.')
}
