import { translate } from '@/i18n/i18n'
import {
  readClaudePinnedLaunchErrorCode,
  type ClaudePinnedLaunchErrorCode
} from '../../../../shared/claude/claude-pinned-launch-error'

const COPY: Record<
  ClaudePinnedLaunchErrorCode,
  { key: string; fallback: string; offerActiveAccount: boolean }
> = {
  'account-missing': {
    key: 'auto.components.terminal.pane.ClaudePinnedLaunch.accountMissing',
    fallback:
      'The saved Claude account for this project is no longer signed in. Change it in Settings → Repository, or start on the active account.',
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

export function describeClaudePinnedLaunchError(
  error: string
): { message: string; offerActiveAccount: boolean } | null {
  const code = readClaudePinnedLaunchErrorCode(error)
  if (!code) {
    return null
  }
  const entry = COPY[code]
  return {
    message: translate(entry.key, entry.fallback),
    offerActiveAccount: entry.offerActiveAccount
  }
}
