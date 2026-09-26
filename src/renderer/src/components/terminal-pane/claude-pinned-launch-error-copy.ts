import { translate } from '@/i18n/i18n'
import {
  readClaudePinnedLaunchErrorCode,
  readClaudePinnedLaunchErrorDetails,
  type ClaudePinnedLaunchErrorCode
} from '../../../../shared/claude/claude-pinned-launch-error'

const COPY: Record<
  ClaudePinnedLaunchErrorCode,
  { key: string; fallback: string; offerActiveAccount: boolean; offerRetry?: boolean }
> = {
  'host-sessions': {
    key: 'auto.components.terminal.pane.ClaudePinnedLaunch.hostSessions',
    fallback:
      'This Claude account is still used by terminals started while it was the active account. Close them, or start on the active account this time.',
    offerActiveAccount: true
  },
  'host-mutation': {
    key: 'auto.components.terminal.pane.ClaudePinnedLaunch.hostMutation',
    fallback: 'Claude accounts are being updated. Try again in a moment.',
    offerActiveAccount: false,
    offerRetry: true
  },
  'usage-fetch': {
    key: 'auto.components.terminal.pane.ClaudePinnedLaunch.usageFetch',
    fallback: 'Checking account usage took too long. Try again.',
    offerActiveAccount: false,
    offerRetry: true
  },
  'account-missing': {
    key: 'auto.components.terminal.pane.ClaudePinnedLaunch.accountMissing',
    fallback:
      'The saved Claude account for this project is no longer signed in. Change it in Settings → Repository, or start on the active account.',
    offerActiveAccount: true
  },
  'became-active': {
    key: 'auto.components.terminal.pane.ClaudePinnedLaunch.becameActive',
    fallback: 'That account just became the active account. Try again.',
    offerActiveAccount: false,
    offerRetry: true
  },
  credentials: {
    key: 'auto.components.terminal.pane.ClaudePinnedLaunch.credentials',
    fallback:
      'This Claude account needs to sign in again. Re-authenticate it in Settings → Accounts.',
    offerActiveAccount: true
  },
  provenance: {
    key: 'auto.components.terminal.pane.ClaudePinnedLaunch.provenance',
    fallback: "Couldn't confirm the Claude account for this session, so it wasn't started.",
    offerActiveAccount: false
  },
  'unsupported-host': {
    key: 'auto.components.terminal.pane.ClaudePinnedLaunch.unsupportedHost',
    fallback:
      "A saved Claude account can't be used in WSL yet. Start on the active account, or set this project's account to Default in Settings → Repository.",
    offerActiveAccount: true
  }
}

function describeHostSessions(error: string): string | null {
  const { email, terminalCount } = readClaudePinnedLaunchErrorDetails(error)
  if (!email || terminalCount === undefined || terminalCount < 1) {
    return null
  }
  return terminalCount === 1
    ? translate(
        'auto.components.terminal.pane.ClaudePinnedLaunch.hostSessionsDetail_one',
        '{{email}} is still used by {{count}} Claude terminal started while it was the active account. Close it, or start on the active account this time.',
        { email, count: terminalCount }
      )
    : translate(
        'auto.components.terminal.pane.ClaudePinnedLaunch.hostSessionsDetail_other',
        '{{email}} is still used by {{count}} Claude terminals started while it was the active account. Close them, or start on the active account this time.',
        { email, count: terminalCount }
      )
}

export function describeClaudePinnedLaunchError(
  error: string
): { message: string; offerActiveAccount: boolean; offerRetry: boolean } | null {
  const code = readClaudePinnedLaunchErrorCode(error)
  if (!code) {
    return null
  }
  const entry = COPY[code]
  return {
    message:
      (code === 'host-sessions' ? describeHostSessions(error) : null) ??
      translate(entry.key, entry.fallback),
    offerActiveAccount: entry.offerActiveAccount,
    offerRetry: entry.offerRetry === true
  }
}
