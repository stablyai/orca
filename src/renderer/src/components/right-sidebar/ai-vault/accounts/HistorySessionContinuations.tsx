import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { historyResumeActivityKey, useHistoryResumeActivity } from './history-resume-activity'
import { Button } from '@/components/ui/button'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { useHistoryAccountContext } from './history-account-context'

export function HistorySessionContinuations({
  session,
  onResume
}: {
  session: AiVaultSession
  onResume?: (session: AiVaultSession) => void
}) {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const { catalogs } = useHistoryAccountContext()
  const entries = useHistoryResumeActivity((state) => state.entries)
  if (!session.continuationVersions || session.continuationVersions.length < 2) {
    return null
  }
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        {t('historyResume.versions', 'Continuations ({{count}})', {
          count: session.continuationVersions.length
        })}
      </summary>
      <div className="mt-2 space-y-1">
        {session.continuationVersions.map((version) => {
          const account = catalogs[session.executionHostId]?.[version.provider].accounts.find(
            (entry) => entry.id === version.accountId
          )
          const label =
            version.accountId === null
              ? t('accounts.claude.systemDefault', 'System default')
              : (account?.displayName ??
                account?.email ??
                t('historyResume.lastUnknown', 'Last used account not recorded'))
          const activity =
            entries[
              historyResumeActivityKey({
                ...session,
                sessionId: version.sessionId,
                filePath: version.filePath
              })
            ]
          return (
            <Button
              key={version.filePath}
              variant="ghost"
              size="xs"
              className="w-full justify-start"
              disabled={!onResume || Boolean(activity && activity.phase !== 'error')}
              onClick={() =>
                onResume?.({
                  ...session,
                  sessionId: version.sessionId,
                  filePath: version.filePath,
                  resumeCommand: '',
                  codexHome: version.provider === 'codex' ? version.home : null,
                  accountHome: {
                    variable: version.provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR',
                    path: version.home
                  },
                  resumeExactVersion: true
                })
              }
            >
              {label} ·{' '}
              {version.openedAt
                ? new Date(version.openedAt).toLocaleString(intlLocale)
                : version.parentSessionId
                  ? t('historyResume.notOpened', 'Not opened in Orca')
                  : t('historyResume.original', 'Original conversation')}
            </Button>
          )
        })}
      </div>
    </details>
  )
}
