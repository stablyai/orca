// One S0 row per agent: picks the state's row and keeps the row's own Remove / save-error state.
import type React from 'react'
import { useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import type { OrcaCloudAccountRow } from '@/lib/orca-cloud/orca-cloud-agent-accounts-model'
import type {
  OrcaCloudAccountAgent,
  OrcaCloudAgentsErrorCode
} from '../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { RowShell } from './orca-cloud-account-row-shell'
import { agentName, keyPhrase, productName, setupFailureCopy } from './orca-cloud-accounts-copy'
import type { OrcaCloudAccountsActions } from './orca-cloud-accounts-types'
import { ActiveRow, ChoiceRow } from './OrcaCloudActiveRow'
import { SetupRow } from './OrcaCloudSetupRow'
import { RemoveConfirmRow, RowRemoveMenu } from './OrcaCloudRemoveRow'

export function AccountRow({
  agent,
  row,
  actions,
  now,
  initialConfirmRemove,
  initialRowError
}: {
  agent: OrcaCloudAccountAgent
  row: OrcaCloudAccountRow
  actions: OrcaCloudAccountsActions
  now: number
  initialConfirmRemove: boolean
  initialRowError: OrcaCloudAgentsErrorCode | null
}): React.JSX.Element {
  const t = useTranslate()
  const [confirmRemove, setConfirmRemove] = useState(initialConfirmRemove)
  const [rowError, setRowError] = useState<OrcaCloudAgentsErrorCode | null>(initialRowError)
  const product = productName(agent, t)
  const useAccount =
    agent === 'claude'
      ? t('orcaCloudAccounts.useClaude', 'Use my Claude account')
      : t('orcaCloudAccounts.useChatGPT', 'Use my ChatGPT account')
  let content: React.JSX.Element
  switch (row.kind) {
    case 'notSetUp':
      content = (
        <RowShell
          agent={agent}
          tone="none"
          title={
            row.keyKind
              ? t('orcaCloudAccounts.notSetUpKey', 'Not set up · using {{key}}', {
                  key: keyPhrase(row.keyKind, t)
                })
              : t('orcaCloudAccounts.notSetUp', 'Not set up')
          }
          detail={t(
            'orcaCloudAccounts.notSetUpDetail',
            'One sign-in. Then every cloud workspace can use it.'
          )}
          actions={
            <Button type="button" variant="outline" size="sm" onClick={() => actions.start(agent)}>
              {useAccount}
            </Button>
          }
        >
          {/* The paste path stays reachable without the browser (RA-5), as a real action (JA-23). */}
          {agent === 'claude' ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-2.5 mt-1"
              onClick={actions.usePaste}
            >
              {t('orcaCloudAccounts.pasteTokenInstead', 'Paste a token instead')}
            </Button>
          ) : null}
        </RowShell>
      )
      break
    case 'setup':
      content = <SetupRow agent={agent} row={row} actions={actions} now={now} />
      break
    case 'failed': {
      const copy = setupFailureCopy(agent, row.error, t)
      content = (
        <RowShell
          agent={agent}
          tone="error"
          title={copy.title}
          detail={copy.detail}
          actions={
            <Button type="button" variant="outline" size="sm" onClick={() => actions.start(agent)}>
              {t('orcaCloudAccounts.tryAgain', 'Try again')}
            </Button>
          }
        />
      )
      break
    }
    case 'choice':
      content = (
        <ChoiceRow
          agent={agent}
          keyKind={row.keyKind ?? 'team'}
          actions={actions}
          setRowError={setRowError}
        />
      )
      break
    case 'active':
      content = (
        <ActiveRow
          agent={agent}
          row={row}
          actions={actions}
          confirmRemove={confirmRemove}
          setConfirmRemove={setConfirmRemove}
          setRowError={setRowError}
        />
      )
      break
    case 'expired':
      content = confirmRemove ? (
        <RemoveConfirmRow
          agent={agent}
          actions={actions}
          setConfirmRemove={setConfirmRemove}
          setRowError={setRowError}
        />
      ) : (
        <RowShell
          agent={agent}
          tone="warning"
          title={t('orcaCloudAccounts.expired', 'Your {{agent}} sign-in expired', {
            agent: agentName(agent, t)
          })}
          detail={
            row.covered
              ? t(
                  'orcaCloudAccounts.expiredDetail',
                  'Cloud workspaces use {{key}} until you renew. Nothing else changed.',
                  { key: keyPhrase(row.keyKind ?? 'team', t) }
                )
              : t(
                  'orcaCloudAccounts.expiredDetailNoKey',
                  'Cloud workspaces ask you to sign in until you renew.'
                )
          }
          actions={
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => actions.start(agent)}
              >
                {t('orcaCloudAccounts.renew', 'Renew')}
              </Button>
              <RowRemoveMenu agent={agent} onRemove={() => setConfirmRemove(true)} />
            </>
          }
        />
      )
      break
    case 'killSwitch':
      content = (
        <RowShell
          agent={agent}
          tone="info"
          title={t('orcaCloudAccounts.killSwitch', 'Signs in for each cloud workspace')}
          detail={t(
            'orcaCloudAccounts.killSwitchDetail',
            'Orca can’t use your {{product}} account in cloud workspaces right now. Each new cloud workspace asks once until it’s back.',
            { product }
          )}
        />
      )
      break
    case 'unavailable':
      content = (
        <RowShell
          agent={agent}
          tone="info"
          title={t('orcaCloudAccounts.unavailable', 'Signs in for each cloud workspace')}
          detail={t(
            'orcaCloudAccounts.unavailableDetail',
            'Signing in once with your {{product}} account isn’t available in Orca Cloud yet. Each new cloud workspace asks you to sign in.',
            { product }
          )}
        />
      )
      break
  }
  if (!rowError) {
    return content
  }
  return (
    <>
      {content}
      <li className="pb-3">
        <InlineError
          density="compact"
          title={t('orcaCloudAccounts.error.saveFailed', 'Couldn’t save to your Orca account.')}
          detail={t('orcaCloudAccounts.error.nothingChanged', 'Nothing was changed.')}
          retryLabel={t('orcaCloudAccounts.dismiss', 'Dismiss')}
          onRetry={() => setRowError(null)}
        />
      </li>
    </>
  )
}

/** One polite announcement per setup step ("Claude: finish in your browser"). */
