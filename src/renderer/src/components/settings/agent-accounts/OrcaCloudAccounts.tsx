// S0 · Settings › Agent accounts › Orca Cloud (agent-accounts spec §5): the one place a Claude or
// ChatGPT account is connected to Orca Cloud, once, on this computer. Rows show states only; the
// setup-token is captured in main and a pasted one goes to main once and never comes back.
import type React from 'react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
import type { OrcaCloudAccountRow } from '@/lib/orca-cloud/orca-cloud-agent-accounts-model'
import {
  ORCA_CLOUD_ACCOUNT_AGENTS,
  type OrcaCloudAccountAgent
} from '../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { SettingsGroupHeader } from '../section-layout/SettingsGroup'
import { agentName } from './orca-cloud-accounts-copy'
import type { OrcaCloudAccountsViewProps } from './orca-cloud-accounts-types'
import { AccountRow } from './OrcaCloudAccountRow'

export type {
  OrcaCloudAccountsActions,
  OrcaCloudAccountsViewProps
} from './orca-cloud-accounts-types'

export const ORCA_CLOUD_ACCOUNTS_SECTION_ID = 'orca-cloud'

function setupAnnouncement(
  rows: Record<OrcaCloudAccountAgent, OrcaCloudAccountRow>,
  t: Translate
): string {
  const parts: string[] = []
  for (const agent of ORCA_CLOUD_ACCOUNT_AGENTS) {
    const row = rows[agent]
    const name = agentName(agent, t)
    if (row.kind === 'setup') {
      const phase = row.setup.phase
      const step =
        phase === 'browser'
          ? t('orcaCloudAccounts.announce.browser', 'finish in your browser')
          : phase === 'preparing'
            ? t('orcaCloudAccounts.announce.preparing', 'getting sign-in ready')
            : phase === 'device'
              ? t('orcaCloudAccounts.announce.device', 'enter the code on the sign-in page')
              : phase === 'paste'
                ? t('orcaCloudAccounts.announce.paste', 'paste the token')
                : t('orcaCloudAccounts.announce.saving', 'saving')
      parts.push(`${name}: ${step}`)
    } else if (row.kind === 'active' || row.kind === 'choice') {
      parts.push(`${name}: ${t('orcaCloudAccounts.announce.saved', 'set up')}`)
    }
  }
  return parts.join('. ')
}

function LoadingRows(): React.JSX.Element {
  const t = useTranslate()
  return (
    <ul aria-busy="true" className="px-5">
      {ORCA_CLOUD_ACCOUNT_AGENTS.map((agent) => (
        <li
          key={agent}
          className="grid min-h-16 grid-cols-[5rem_minmax(0,1fr)] items-center gap-x-4 border-t border-border py-3 first:border-t-0"
        >
          <h4 className="text-sm font-medium text-foreground">{agentName(agent, t)}</h4>
          <div className="space-y-1.5">
            <Skeleton className="h-3.5 w-56" />
            <Skeleton className="h-3 w-80" />
          </div>
        </li>
      ))}
      <li className="sr-only">{t('orcaCloudAccounts.loading', 'Loading agent accounts…')}</li>
    </ul>
  )
}

export function OrcaCloudAccountsView({
  load,
  rows,
  actions,
  now,
  initialConfirmRemove,
  initialRowError,
  hideHeader = false
}: OrcaCloudAccountsViewProps): React.JSX.Element | null {
  const t = useTranslate()
  const announcement = rows ? setupAnnouncement(rows, t) : ''
  if (load.kind === 'unavailable') {
    return null
  }
  if (rows && ORCA_CLOUD_ACCOUNT_AGENTS.every((agent) => rows[agent].kind === 'unavailable')) {
    // Neither provider is offered on this server: one muted line keeps the section findable.
    return (
      <section id={ORCA_CLOUD_ACCOUNTS_SECTION_ID} className="space-y-3">
        <SettingsGroupHeader
          title={t('orcaCloudAccounts.title', 'Orca Cloud')}
          description={t(
            'orcaCloudAccounts.allUnavailable',
            'Claude and Codex sign in for each cloud workspace for now.'
          )}
        />
      </section>
    )
  }
  const signedOut = load.kind === 'failed' && load.error === 'signed_out'
  let body: React.JSX.Element
  if (load.kind === 'loading' || (load.kind === 'ready' && !rows)) {
    body = <LoadingRows />
  } else if (signedOut) {
    body = (
      <InlineError
        tone="neutral"
        className="m-4"
        title={t(
          'orcaCloudAccounts.signedOut',
          'Sign in to Orca to use your accounts in cloud workspaces.'
        )}
        action={
          <Button type="button" variant="outline" size="xs" onClick={actions.signIn}>
            {t('orcaCloudAccounts.signIn', 'Sign in')}
          </Button>
        }
      />
    )
  } else if (load.kind === 'failed' || !rows) {
    body = (
      <InlineError
        className="m-4"
        title={t('orcaCloudAccounts.loadFailed', 'Couldn’t load your agent accounts.')}
        detail={t('orcaCloudAccounts.error.nothingChanged', 'Nothing was changed.')}
        retryLabel={t('orcaCloudAccounts.tryAgain', 'Try again')}
        onRetry={actions.retryLoad}
      />
    )
  } else {
    body = (
      <ul className="px-5">
        {ORCA_CLOUD_ACCOUNT_AGENTS.map((agent) => (
          <AccountRow
            key={agent}
            agent={agent}
            row={rows[agent]}
            actions={actions}
            now={now}
            initialConfirmRemove={initialConfirmRemove === agent}
            initialRowError={initialRowError?.agent === agent ? initialRowError.error : null}
          />
        ))}
      </ul>
    )
  }
  return (
    <section id={ORCA_CLOUD_ACCOUNTS_SECTION_ID} className="space-y-3">
      {hideHeader ? null : (
        <SettingsGroupHeader
          title={t('orcaCloudAccounts.title', 'Orca Cloud')}
          description={t(
            'orcaCloudAccounts.helpAccountWide',
            'Set up once. Every cloud workspace uses it, including new, cloned and restarted ones.'
          )}
        />
      )}
      <div className="overflow-hidden rounded-xl border border-border bg-card/50 shadow-xs">
        {body}
      </div>
      {/* Mandatory (spec §5 item 5): the A1 mitigation depends on this line. */}
      <p className="px-1 text-xs text-muted-foreground">
        {t(
          'orcaCloudAccounts.policy',
          'Your Claude and ChatGPT accounts are used only in your own workspaces. Teammates never use them.'
        )}
      </p>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </section>
  )
}
