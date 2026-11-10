// The Cloud workspace status panel's door into the A16 panel: "Agents and secrets · {{summary}}".
// The summary reads the Orca account only (never the sandbox), like the panel's section 1.
import React from 'react'
import { ChevronRight, KeyRound } from 'lucide-react'
import { useAppStore } from '@/store'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useOrcaCloudAgentAccounts } from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import {
  orcaCloudAgentCoverage,
  type OrcaCloudAgentCoverage
} from '@/lib/orca-cloud/orca-cloud-agent-accounts-model'
import { ORCA_CLOUD_ACCOUNT_AGENTS } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { getWorktreeExecutionHostId } from '../../../../shared/execution-host'
import { agentName, keyOptionLabel } from '../settings/agent-accounts/orca-cloud-accounts-copy'
import { openAgentHostPanel } from './agent-host-panel-store'

function coverageWord(coverage: OrcaCloudAgentCoverage, t: Translate): string {
  switch (coverage.kind) {
    case 'account':
      return t('agentHostPanel.summary.account', 'your account')
    case 'key':
      return keyOptionLabel(coverage.keyKind, t).toLocaleLowerCase()
    case 'notSetUp':
      return t('agentHostPanel.summary.notSetUp', 'not set up')
    case 'expired':
      return t('agentHostPanel.summary.expired', 'expired')
    case 'killSwitch':
    case 'unavailable':
      return t('agentHostPanel.summary.signsInHere', 'signs in here')
  }
}

export function CloudAgentsAndSecretsLink({
  workspaceId
}: {
  workspaceId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const accounts = useOrcaCloudAgentAccounts()
  const hostId = useAppStore((s) => {
    for (const repo of s.repos) {
      const worktree = (s.worktreesByRepo[repo.id] ?? []).find((entry) => entry.id === workspaceId)
      if (worktree) {
        return getWorktreeExecutionHostId(worktree, repo)
      }
    }
    return null
  })
  if (!hostId) {
    return null
  }
  const status = accounts.load.kind === 'ready' ? accounts.load.status : null
  const summary = status
    ? ORCA_CLOUD_ACCOUNT_AGENTS.map((agent) =>
        t('agentHostPanel.summary.agent', '{{agent}} · {{source}}', {
          agent: agentName(agent, t),
          source: coverageWord(orcaCloudAgentCoverage(agent, status, accounts.keyKinds[agent]), t)
        })
      ).join(', ')
    : null
  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-center gap-2 rounded-md py-1 text-start text-xs text-foreground hover:bg-muted/50 focus-visible:outline-[var(--focus-ring)]"
      onClick={() => openAgentHostPanel({ hostId, workspaceId })}
    >
      <KeyRound aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">
        {summary
          ? t('agentHostPanel.entry.statusPanel', 'Agents and secrets · {{summary}}', { summary })
          : t('agentHostPanel.entry.statusPanelPlain', 'Agents and secrets')}
      </span>
      <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  )
}
