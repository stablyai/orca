import { CLAUDE_SIGN_IN_FAILED_MESSAGE } from '../../../../shared/claude-sign-in-link'
import { CODEX_LOGIN_CANCELLED_MESSAGE } from '../../../../shared/codex-auth-errors'
import { translate } from '@/i18n/i18n'

const CODEX_SIGN_IN_FAILED_MESSAGE = 'Codex sign-in failed. Please try again.'

function codexSignInFailedMessage(): string {
  return translate(
    'auto.components.status.bar.StatusBar.codexSignInError',
    CODEX_SIGN_IN_FAILED_MESSAGE
  )
}

function codexSignInTimedOutMessage(): string {
  return translate(
    'auto.components.settings.accountsPaneActionErrors.codexSignInTimedOut',
    'Codex sign-in took too long to finish. Please try again.'
  )
}

export function getCodexAccountErrorDescription(error: unknown): string {
  const message = String((error as Error)?.message ?? error)
    .replace(/^Error occurred in handler for 'codexAccounts:[^']+':\s*/i, '')
    .replace(/^Error invoking remote method 'codexAccounts:[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
  const normalizedMessage = message.toLowerCase()

  // Normalize expected auth failures into actionable guidance without Electron wrappers or raw upstream wording.
  if (normalizedMessage.includes('timed out waiting for codex login to finish')) {
    return codexSignInTimedOutMessage()
  }
  if (normalizedMessage.includes('codex sign-in took too long to finish')) {
    return codexSignInTimedOutMessage()
  }
  if (
    normalizedMessage.includes('auth error 502') ||
    normalizedMessage.includes('gateway') ||
    normalizedMessage.includes('bad gateway')
  ) {
    return translate(
      'auto.components.settings.accountsPaneActionErrors.codexSignInUnavailable',
      'Codex sign-in is temporarily unavailable. Please try again in a minute.'
    )
  }
  if (normalizedMessage.startsWith('codex login failed:')) {
    const loginMessage = message.slice('Codex login failed:'.length).trim()
    return loginMessage || codexSignInFailedMessage()
  }

  return message && message !== CODEX_SIGN_IN_FAILED_MESSAGE ? message : codexSignInFailedMessage()
}

export function getClaudeAccountErrorDescription(error: unknown): string {
  const message = String((error as Error)?.message ?? error)
    .replace(/^Error occurred in handler for 'claudeAccounts:[^']+':\s*/i, '')
    .replace(/^Error invoking remote method 'claudeAccounts:[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
  return message && message !== CLAUDE_SIGN_IN_FAILED_MESSAGE
    ? message
    : translate(
        'auto.components.settings.accountsPaneActionErrors.claudeSignInFailed',
        'Claude sign-in failed. Please try again.'
      )
}

export function isCodexAccountCancellation(error: unknown): boolean {
  return (
    getCodexAccountErrorDescription(error).toLowerCase() ===
    CODEX_LOGIN_CANCELLED_MESSAGE.toLowerCase()
  )
}

export function isClaudeAccountCancellation(error: unknown): boolean {
  return getClaudeAccountErrorDescription(error).toLowerCase() === 'claude sign-in was cancelled.'
}
