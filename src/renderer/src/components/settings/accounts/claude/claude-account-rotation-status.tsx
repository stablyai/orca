import { useEffect, useState } from 'react'
import type { ClaudeAccountRotationStatus } from '../../../../../../shared/agent-accounts/claude/claude-account-rotation'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'

const STATUS_POLL_MS = 15_000

/** Polls the desktop host while the pane is open; null where the host has no rotation (web, remote). */
export function useClaudeAccountRotationStatus(
  settingsKey: unknown
): ClaudeAccountRotationStatus | null {
  const [status, setStatus] = useState<ClaudeAccountRotationStatus | null>(null)
  useEffect(() => {
    const read = window.api.claudeAccounts.rotationStatus
    if (!read) {
      return
    }
    let cancelled = false
    const refresh = (): void => {
      void read()
        .then((next) => {
          if (!cancelled) {
            setStatus(next)
          }
        })
        .catch(() => {})
    }
    // Runs once right away, then on the interval while the window is visible.
    const stop = installWindowVisibilityInterval({ run: refresh, intervalMs: STATUS_POLL_MS })
    return () => {
      cancelled = true
      stop()
    }
  }, [settingsKey])
  return status
}

function formatTime(at: number, locale: string | undefined): string {
  return new Date(at).toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function folderName(
  status: ClaudeAccountRotationStatus,
  accountId: string | null,
  t: Translate
): string {
  const folder = status.folders.find((entry) => entry.accountId === accountId)
  return folder?.label ?? t('accounts.claude.rotation.status.unnamed', 'an unnamed account')
}

function pauseLine(status: ClaudeAccountRotationStatus, t: Translate): string | null {
  if (status.pause === 'no-accounts') {
    return t(
      'accounts.claude.rotation.status.noAccounts',
      'Add at least two Claude accounts on this Mac to switch between them.'
    )
  }
  if (status.switchNeedsRepair) {
    return t(
      'accounts.claude.rotation.status.needsRepair',
      'After the last switch, a folder has no login or one for another account. Switching is paused until that folder is signed in to one of the two accounts again.'
    )
  }
  if (status.pendingSwitch) {
    return t(
      'accounts.claude.rotation.status.pending',
      'Checking the last switch. New switches wait until it is confirmed.'
    )
  }
  if (status.lastNote === 'account_off') {
    return t(
      'accounts.claude.rotation.status.accountOff',
      'The selected account is turned off below, so Orca leaves it as it is.'
    )
  }
  if (status.lastNote === 'over_no_candidate') {
    return t(
      'accounts.claude.rotation.status.noCandidate',
      'The selected account is at its limit and no other account is free. Close sessions on another account or wait for a reset.'
    )
  }
  return null
}

export function ClaudeAccountRotationStatusLines({
  status
}: {
  status: ClaudeAccountRotationStatus
}): React.JSX.Element | null {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const lines: string[] = []
  const pause = pauseLine(status, t)
  if (pause) {
    lines.push(pause)
  }
  if (status.lastSwitch) {
    lines.push(
      t('accounts.claude.rotation.status.lastSwitch', 'Last switch {{when}}: {{from}} to {{to}}.', {
        when: formatTime(status.lastSwitch.at, intlLocale),
        from:
          status.lastSwitch.fromLabel ??
          t('accounts.claude.rotation.status.unnamed', 'an unnamed account'),
        to:
          status.lastSwitch.toLabel ??
          t('accounts.claude.rotation.status.unnamed', 'an unnamed account')
      })
    )
  }
  if (status.pause === null && status.nextCandidateAccountId) {
    lines.push(
      t('accounts.claude.rotation.status.next', 'Next account to switch to: {{account}}.', {
        account: folderName(status, status.nextCandidateAccountId, t)
      })
    )
  }
  if (status.pause === null && status.lastCheckedAt) {
    lines.push(
      t('accounts.claude.rotation.status.checked', 'Last checked {{when}}.', {
        when: formatTime(status.lastCheckedAt, intlLocale)
      })
    )
  }
  if (lines.length === 0) {
    return null
  }
  return (
    <div className="space-y-0.5 py-2 text-settings-detail text-muted-foreground">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  )
}
