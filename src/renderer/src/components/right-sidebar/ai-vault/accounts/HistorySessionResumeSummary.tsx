import { useTranslate } from '@/i18n/use-translate'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { historyAccountInfo, useHistoryAccountContext } from './history-account-context'
import { useAiVaultSessionAccount } from './ai-vault-session-account'
import { SessionAccountSection } from './AiVaultSessionAccount'

function useAccount(session: AiVaultSession, workspaceId?: string) {
  const context = useHistoryAccountContext()
  return historyAccountInfo(
    session,
    context.catalogs[session.executionHostId],
    workspaceId ?? context.workspaceId
  )
}

export function HistorySessionResumeSummary({
  session,
  workspaceId
}: {
  session: AiVaultSession
  workspaceId?: string
}) {
  const t = useTranslate()
  const account = useAccount(session, workspaceId)
  if (!account || session.structuredSession) {
    return null
  }
  return (
    <div className="space-y-1 border-b border-sidebar-border px-3 py-2">
      <p className="text-xs font-medium">
        {account.lastAccountLabel
          ? t('historyResume.lastUsedAccount', 'Last used: {{account}}', {
              account: account.lastAccountLabel
            })
          : t('historyResume.lastUnknown', 'Last used account not recorded')}
      </p>
      <p className="text-xs text-muted-foreground">
        {t(
          'historyResume.choiceHint',
          'If the workspace uses another account, Orca will ask before continuing.'
        )}
      </p>
    </div>
  )
}

export function HistorySessionStorageAccount({ session }: { session: AiVaultSession }) {
  const t = useTranslate()
  const account = useAccount(session)
  const recorded = useAiVaultSessionAccount(session)
  if (!account || session.structuredSession) {
    return <SessionAccountSection accountLabel={recorded} />
  }
  return (
    <p className="text-xs text-muted-foreground">
      {t('aiVault.accounts.savedIn', 'Saved in {{account}}', {
        account:
          account.sourceLabel ??
          (account.sourceId === null
            ? t('accounts.claude.systemDefault', 'System default')
            : t('aiVault.accounts.unknown', 'Unidentified account'))
      })}
    </p>
  )
}
