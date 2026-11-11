// S0 states 2 and 7: the saved account (Source, Remove…) and the one-time Source question.
import type React from 'react'
import { useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { OrcaCloudAccountRow } from '@/lib/orca-cloud/orca-cloud-agent-accounts-model'
import type {
  AgentKeyKind,
  OrcaCloudAccountAgent,
  OrcaCloudAgentsErrorCode
} from '../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { SettingsSegmentedControl } from '../form-controls/SettingsSegmentedControl'
import { formatDate, RowShell } from './orca-cloud-account-row-shell'
import {
  agentName,
  keepKeyLabel,
  keyOptionLabel,
  keyPhrase,
  productName
} from './orca-cloud-accounts-copy'
import type { OrcaCloudAccountsActions } from './orca-cloud-accounts-types'
import { RemoveConfirmRow } from './OrcaCloudRemoveRow'

export function ActiveRow({
  agent,
  row,
  actions,
  confirmRemove,
  setConfirmRemove,
  setRowError
}: {
  agent: OrcaCloudAccountAgent
  row: Extract<OrcaCloudAccountRow, { kind: 'active' }>
  actions: OrcaCloudAccountsActions
  confirmRemove: boolean
  setConfirmRemove: (open: boolean) => void
  setRowError: (error: OrcaCloudAgentsErrorCode | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const product = productName(agent, t)
  const who =
    row.label ??
    t('orcaCloudAccounts.yourAccount', 'Your {{product}} account', {
      product
    })
  const run = async (work: () => Promise<OrcaCloudAgentsErrorCode | null>): Promise<void> => {
    setBusy(true)
    const error = await work()
    setBusy(false)
    setRowError(error)
  }
  if (confirmRemove) {
    return (
      <RemoveConfirmRow
        agent={agent}
        actions={actions}
        setConfirmRemove={setConfirmRemove}
        setRowError={setRowError}
      />
    )
  }
  const renews =
    row.expiresAt !== null
      ? t('orcaCloudAccounts.renewsBy', 'Renews by {{date}}.', { date: formatDate(row.expiresAt) })
      : null
  return (
    <RowShell
      agent={agent}
      tone={row.expiring ? 'warning' : 'done'}
      title={
        row.source === 'sign-in'
          ? t('orcaCloudAccounts.active', '{{email}} · from your Orca account', { email: who })
          : t('orcaCloudAccounts.activeKeyFirst', '{{email}} · saved, using {{key}}', {
              email: who,
              key: keyPhrase(row.keyKind ?? 'team', t)
            })
      }
      // Status is the title; the row adds only the expiry (JA-23). Where it's kept is in the heading's tooltip.
      detail={
        renews ? (
          <span className={cn(row.expiring && 'text-status-warning-text')}>{renews}</span>
        ) : null
      }
      actions={
        <>
          {row.covered && row.keyKind ? (
            <SettingsSegmentedControl
              size="sm"
              activation="manual"
              ariaLabel={t('orcaCloudAccounts.sourceLabel', 'Source for {{agent}}', {
                agent: agentName(agent, t)
              })}
              value={row.source}
              onChange={(source) => {
                if (!busy && source !== row.source) {
                  void run(() => actions.setSource(agent, source))
                }
              }}
              options={[
                {
                  value: 'sign-in',
                  label: t('orcaCloudAccounts.source.account', 'Your account'),
                  disabled: busy
                },
                { value: 'key', label: keyOptionLabel(row.keyKind, t), disabled: busy }
              ]}
            />
          ) : null}
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRemove(true)}>
            {t('orcaCloudAccounts.removeEllipsis', 'Remove…')}
          </Button>
        </>
      }
    />
  )
}

export function ChoiceRow({
  agent,
  keyKind,
  actions,
  setRowError
}: {
  agent: OrcaCloudAccountAgent
  keyKind: AgentKeyKind
  actions: OrcaCloudAccountsActions
  setRowError: (error: OrcaCloudAgentsErrorCode | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const answer = async (source: 'sign-in' | 'key'): Promise<void> => {
    setBusy(true)
    setRowError(await actions.setSource(agent, source))
    setBusy(false)
  }
  return (
    <RowShell
      agent={agent}
      tone="done"
      title={t(
        'orcaCloudAccounts.choice',
        'Saved. Use your {{product}} account instead of {{key}} in your cloud workspaces?',
        { product: productName(agent, t), key: keyPhrase(keyKind, t) }
      )}
      detail={
        keyKind === 'team'
          ? t(
              'orcaCloudAccounts.choiceDetail',
              'Your account’s usage limits apply instead of the team’s bill. You can change this any time.'
            )
          : t(
              'orcaCloudAccounts.choiceDetailKey',
              'Your account’s usage limits apply instead of the key’s billing. You can change this any time.'
            )
      }
      actions={
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void answer('sign-in')}
          >
            {t('orcaCloudAccounts.useMine', 'Use my account')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void answer('key')}
          >
            {keepKeyLabel(keyKind, t)}
          </Button>
        </>
      }
    />
  )
}
