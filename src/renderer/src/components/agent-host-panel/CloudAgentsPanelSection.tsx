// Panel section 1 on Orca Cloud: "From your Orca account" (or the winning key) per agent, the lock line
// and the two-way Source. Nothing here asks the sandbox; there is no sign-in or sign-out on Cloud.
import React from 'react'
import { Lock } from 'lucide-react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type {
  AgentSource,
  OrcaCloudAccountAgent
} from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { SettingsDisabledControlTooltip } from '../settings/form-controls/SettingsDisabledControlTooltip'
import { agentName, keyOptionLabel } from '../settings/agent-accounts/orca-cloud-accounts-copy'
import { LoadingRows, PanelSection } from './cloud-sections/PanelSection'
import type { CloudAgentPanelRow, CloudAgentPanelSource } from './cloud-agents-panel-model'

export type CloudAgentsPanelLoad =
  | { kind: 'loading' }
  | { kind: 'ready'; rows: readonly CloudAgentPanelRow[] }
  | { kind: 'signedOut' }
  | { kind: 'failed' }

export type CloudAgentsPanelActions = {
  chooseSource: (agent: OrcaCloudAccountAgent, source: Exclude<AgentSource, null>) => void
  /** Settings › Agent accounts (S0): set up once, or renew. */
  manage: () => void
  signIn: () => void
  retry: () => void
}

function statusCopy(row: CloudAgentPanelRow, t: Translate): { line: string; detail: string } {
  const agent = agentName(row.agent, t)
  const kept = t('agentHostPanel.cloud.kept', 'Kept outside the sandbox')
  switch (row.status.kind) {
    case 'account':
      return {
        line: row.status.label
          ? t('agentHostPanel.cloud.accountWho', 'From your Orca account · {{email}}', {
              email: row.status.label
            })
          : t('agentHostPanel.cloud.account', 'From your Orca account'),
        detail: kept
      }
    case 'key':
      return { line: keyOptionLabel(row.status.keyKind, t), detail: kept }
    case 'notSetUp':
      return {
        line: t('agentHostPanel.cloud.notSetUp', 'Not set up'),
        detail: t(
          'agentHostPanel.cloud.notSetUpDetail',
          'Set up once on this computer. Every cloud workspace uses it.'
        )
      }
    case 'expired':
      return {
        line: t('agentHostPanel.cloud.expired', 'Your {{agent}} sign-in for Orca Cloud expired', {
          agent
        }),
        detail: t('agentHostPanel.cloud.expiredDetail', 'Renew it once in Agent accounts.')
      }
    case 'sharedUnavailable':
      return {
        line: t('agentHostPanel.cloud.sharedUnavailable', 'Not available in shared workspaces'),
        detail: t(
          'agentHostPanel.cloud.sharedUnavailableDetail',
          'Personal accounts aren’t used in shared workspaces. Ask an owner or admin to add a team key.'
        )
      }
    case 'signsInHere':
      return {
        line: t('agentHostPanel.cloud.signsInHere', '{{agent}} signs in for this workspace', {
          agent
        }),
        // Matches the build sheet's Agents row (§5c, #289).
        detail:
          row.status.reason === 'paused'
            ? t('vmBuildAgents.paused', 'Orca account sign-in is paused')
            : t('vmBuildAgents.notOffered', 'Signs in for each cloud workspace for now')
      }
  }
}

function SourceControl({
  agent,
  source,
  disabledReason,
  onChoose
}: {
  agent: OrcaCloudAccountAgent
  source: CloudAgentPanelSource
  disabledReason: string | null
  onChoose: CloudAgentsPanelActions['chooseSource']
}): React.JSX.Element {
  const t = useTranslate()
  const label = t('agentHostPanel.cloud.sourceLabel', '{{agent}} source in this workspace', {
    agent: agentName(agent, t)
  })
  const account = t('vmBuildAgents.menu.yourAccount', 'Your account')
  const key = keyOptionLabel(source.keyKind, t)
  const reasonId = React.useId()
  if (disabledReason) {
    // aria-disabled keeps it focusable so the reason reaches keyboard and screen-reader users.
    return (
      <SettingsDisabledControlTooltip reason={disabledReason}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-disabled="true"
          aria-label={label}
          aria-describedby={reasonId}
          className="w-36 justify-start"
        >
          {source.value === 'key' ? key : source.value === 'sign-in' ? account : '—'}
          <span id={reasonId} className="sr-only">
            {disabledReason}
          </span>
        </Button>
      </SettingsDisabledControlTooltip>
    )
  }
  return (
    <Select
      value={source.value ?? undefined}
      onValueChange={(value) => {
        if (value === 'sign-in' || value === 'key') {
          onChoose(agent, value)
        }
      }}
    >
      <SelectTrigger size="sm" className="w-36" aria-label={label}>
        <SelectValue placeholder={t('agentHostPanel.cloud.choose', 'Choose')} />
      </SelectTrigger>
      <SelectContent position="popper" align="end">
        <SelectItem value="sign-in">{account}</SelectItem>
        <SelectItem value="key">{key}</SelectItem>
      </SelectContent>
    </Select>
  )
}

function RowAction({
  row,
  disabledReason,
  actions
}: {
  row: CloudAgentPanelRow
  disabledReason: string | null
  actions: CloudAgentsPanelActions
}): React.JSX.Element | null {
  const t = useTranslate()
  if (row.source) {
    return (
      <SourceControl
        agent={row.agent}
        source={row.source}
        disabledReason={disabledReason}
        onChoose={actions.chooseSource}
      />
    )
  }
  if (row.status.kind === 'notSetUp' || row.status.kind === 'expired') {
    return (
      <Button type="button" variant="outline" size="xs" onClick={actions.manage}>
        {row.status.kind === 'expired'
          ? t('agentHostPanel.cloud.renew', 'Renew')
          : t('agentHostPanel.cloud.setUp', 'Set up once')}
      </Button>
    )
  }
  return null
}

export function CloudAgentsPanelSection({
  title,
  help,
  load,
  sourceDisabledReason,
  actions
}: {
  title: string
  help: string
  load: CloudAgentsPanelLoad
  /** Shared workspace, archived, or this workspace's choice couldn't be read. */
  sourceDisabledReason: string | null
  actions: CloudAgentsPanelActions
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <PanelSection title={title} help={help}>
      {load.kind === 'loading' ? (
        <LoadingRows />
      ) : load.kind === 'signedOut' ? (
        <InlineError
          tone="neutral"
          density="compact"
          title={t(
            'agentHostPanel.cloud.signedOut',
            'Sign in to Orca to manage this workspace’s agents.'
          )}
          action={
            <Button type="button" variant="outline" size="xs" onClick={actions.signIn}>
              {t('agentHostPanel.cloud.signIn', 'Sign in')}
            </Button>
          }
        />
      ) : load.kind === 'failed' ? (
        <InlineError
          density="compact"
          title={t('agentHostPanel.cloud.failed', 'Couldn’t load your agent accounts.')}
          retryLabel={t('agentHostPanel.retry', 'Try again')}
          onRetry={actions.retry}
        />
      ) : (
        <ul className="flex flex-col divide-y divide-border/60">
          {load.rows.map((row) => {
            const copy = statusCopy(row, t)
            const outside = row.status.kind === 'account' || row.status.kind === 'key'
            return (
              <li
                key={row.agent}
                data-agent={row.agent}
                className="grid grid-cols-[5rem_minmax(0,1fr)_auto] items-center gap-x-3 py-2.5"
              >
                <span className="text-sm text-foreground">{agentName(row.agent, t)}</span>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="break-words text-sm text-foreground">{copy.line}</span>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    {outside ? <Lock aria-hidden className="size-3 shrink-0" /> : null}
                    {copy.detail}
                  </span>
                </div>
                <RowAction row={row} disabledReason={sourceDisabledReason} actions={actions} />
              </li>
            )
          })}
        </ul>
      )}
    </PanelSection>
  )
}
