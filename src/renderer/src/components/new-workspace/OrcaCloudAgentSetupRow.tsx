// The "Set up Orca Cloud" panel's Agent row (cloud-start G). It replaces the old "Add an agent /
// Later" hint: it says how the composer's agent will sign in, links to the one-time setup in
// Settings → Agent accounts, and never blocks Start or signs in per sandbox.
import { useEffect } from 'react'
import { openOrcaCloudSignInSheet } from '@/components/settings/agent-accounts/sign-in-sheet/orca-cloud-sign-in-sheet-store'
import { CircleCheck, CircleDashed, Info, TriangleAlert } from 'lucide-react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  orcaCloudAgentSetupRow,
  type OrcaCloudAgentSetupRowModel
} from '@/lib/orca-cloud/orca-cloud-agent-setup-row'
import {
  reloadOrcaCloudAgentAccounts,
  useOrcaCloudAgentAccounts
} from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import { noteComposerAgentCoverage } from '@/lib/orca-cloud/cloud-first-start-agent-coverage'
import type { OrcaCloudRunTargetAccess } from './orca-cloud-run-target-access'
import { agentName, keySourceLabel } from '../settings/agent-accounts/orca-cloud-accounts-copy'

/** The focused Orca Cloud sign-in sheet (JA-04), over the composer, which stays open. */
export function openOrcaCloudAgentAccounts(): void {
  openOrcaCloudSignInSheet()
}

export function orcaCloudAgentCoveredLabel(
  row: Extract<OrcaCloudAgentSetupRowModel, { kind: 'covered' }>,
  t: Translate
): string {
  const agent = agentName(row.agent, t)
  return row.via === 'account'
    ? t('orcaCloudAgentRow.fromAccount', '{{agent}} · from your Orca account', { agent })
    : t('orcaCloudAgentRow.viaKey', '{{agent}} · {{key}}', {
        agent,
        key: keySourceLabel(row.via, t)
      })
}

/** The row's words and action, shared with the setup panel's Agent step. */
export function orcaCloudAgentRowCopy(
  row: Exclude<OrcaCloudAgentSetupRowModel, { kind: 'hidden' | 'covered' | 'loading' }>,
  t: Translate
): { detail: string; status?: string; action?: { label: string; onClick: () => void } } {
  const agent = agentName(row.agent, t)
  switch (row.kind) {
    case 'notSetUp':
      return {
        detail: t(
          'orcaCloudAgentRow.notSetUp',
          '{{agent}} isn’t set up for Orca Cloud yet. Set it up once in Settings → Agent accounts.',
          { agent }
        ),
        action: {
          label: t('orcaCloudAgentRow.setUpOnce', 'Set up once'),
          onClick: openOrcaCloudAgentAccounts
        }
      }
    case 'expired':
      return {
        detail: t(
          'orcaCloudAgentRow.expired',
          'Your {{agent}} sign-in for Orca Cloud expired. Renew it once in Settings → Agent accounts.',
          { agent }
        ),
        action: {
          label: t('orcaCloudAgentRow.renew', 'Renew'),
          onClick: openOrcaCloudAgentAccounts
        }
      }
    case 'killSwitch':
      return {
        detail: t(
          'orcaCloudAgentRow.killSwitch',
          '{{agent}} signs in for each cloud workspace while Orca account sign-in is paused.',
          { agent }
        )
      }
    case 'signedOut':
      return {
        detail: t(
          'orcaCloudAgentRow.signedOut',
          '{{agent}}: set up once in Settings → Agent accounts after you sign in',
          { agent }
        ),
        status: t('orcaCloudAgentRow.optional', 'Optional')
      }
    case 'error':
      return {
        detail: t(
          'orcaCloudAgentRow.error',
          'Couldn’t check whether {{agent}} is set up for Orca Cloud. You can still start.',
          { agent }
        ),
        action: {
          label: t('orcaCloudAgentRow.tryAgain', 'Try again'),
          onClick: () => void reloadOrcaCloudAgentAccounts()
        }
      }
  }
}

function RowIcon({ kind }: { kind: OrcaCloudAgentSetupRowModel['kind'] }): React.JSX.Element {
  const base = 'size-4 shrink-0'
  switch (kind) {
    case 'expired':
    case 'error':
      return <TriangleAlert aria-hidden className={`${base} text-status-warning-text`} />
    case 'killSwitch':
      return <Info aria-hidden className={`${base} text-muted-foreground`} />
    case 'covered':
    case 'hidden':
    case 'loading':
    case 'notSetUp':
    case 'signedOut':
      return <CircleDashed aria-hidden className={`${base} text-muted-foreground`} />
  }
}

export function OrcaCloudAgentSetupRowView({
  row
}: {
  row: OrcaCloudAgentSetupRowModel
}): React.JSX.Element | null {
  const t = useTranslate()
  const label = t('orcaCloudAgentRow.label', 'Agent')
  if (row.kind === 'hidden') {
    return null
  }
  if (row.kind === 'covered') {
    // Collapsed: one quiet line, like the returning-user composer (cloud-start E).
    const text = orcaCloudAgentCoveredLabel(row, t)
    return (
      <p
        data-orca-cloud-agent-row="covered"
        className="flex min-h-6 items-center gap-2 px-1 text-xs text-muted-foreground"
      >
        <CircleCheck aria-hidden className="size-3.5 shrink-0" />
        <span className="font-medium text-foreground">{label}</span>
        <span className="min-w-0 truncate">{text}</span>
      </p>
    )
  }
  if (row.kind === 'loading') {
    return (
      <div
        data-orca-cloud-agent-row="loading"
        aria-busy="true"
        className="flex min-h-[3.25rem] flex-col justify-center gap-1.5 rounded-md border border-border px-3 py-2.5"
      >
        <span className="sr-only">
          {t('orcaCloudAgentRow.checking', 'Checking {{agent}}', {
            agent: agentName(row.agent, t)
          })}
        </span>
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="h-3 w-64" />
      </div>
    )
  }
  const copy = orcaCloudAgentRowCopy(row, t)
  return (
    <div
      role="group"
      aria-label={[label, copy.detail, copy.status].filter(Boolean).join(', ')}
      data-orca-cloud-agent-row={row.kind}
      className="flex flex-col items-start gap-0.5 rounded-md border border-border px-3 py-2.5 text-sm"
    >
      <div className="flex min-h-8 w-full items-center gap-3">
        <RowIcon kind={row.kind} />
        <span className="min-w-0 flex-1 text-foreground">{label}</span>
        {copy.action ? (
          <Button type="button" variant="outline" size="sm" onClick={copy.action.onClick}>
            {copy.action.label}
          </Button>
        ) : copy.status ? (
          <span className="shrink-0 text-muted-foreground">{copy.status}</span>
        ) : null}
      </div>
      {/* Indented to the label: icon (16px) + gap (12px). */}
      <p className="w-full min-w-0 pl-7 text-muted-foreground">{copy.detail}</p>
    </div>
  )
}

export function OrcaCloudAgentSetupRow({
  agent,
  access,
  githubBlocked = false
}: {
  agent: string | null
  access: OrcaCloudRunTargetAccess
  githubBlocked?: boolean
}): React.JSX.Element | null {
  const accounts = useOrcaCloudAgentAccounts()
  const row = orcaCloudAgentSetupRow({ agent, access, githubBlocked, accounts })
  useEffect(() => {
    noteComposerAgentCoverage(row)
  })
  return <OrcaCloudAgentSetupRowView row={row} />
}
