import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { translate } from '@/i18n/i18n'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'

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

export function botErrorMessage(error: unknown): string {
  // Runtime errors carry the controller's code as their message.
  if (error instanceof Error && error.message === 'bot_name_taken') {
    return translate('bots.errors.nameTaken', 'Another bot already has that name.')
  }
  if (error instanceof Error && error.message === 'bot_avatar_invalid') {
    return translate(
      'bots.errors.avatarInvalid',
      'That picture could not be used. Pick a PNG or JPG image.'
    )
  }
  return translate('bots.errors.generic', 'Something went wrong. Try again.')
}
