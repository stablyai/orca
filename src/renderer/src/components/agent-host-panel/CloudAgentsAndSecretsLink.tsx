// The Cloud workspace status panel's door into the agent accounts panel: "Agents and secrets · {{summary}}".
// The summary reads the Orca account only (never the sandbox), like the panel's section 1.
import React from 'react'
import { ChevronRight, KeyRound } from 'lucide-react'
import { useAppStore } from '@/store'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useOrcaCloudAgentAccounts } from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import {
  orcaCloudAgentCoverage,
  type OrcaCloudAgentCoverage
} from '@/lib/orca-cloud/orca-cloud-agent-accounts-model'
import {
  ORCA_CLOUD_ACCOUNT_AGENTS,
  type AgentKeyKind,
  type OrcaCloudAccountAgent
} from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { agentList } from '../worktree-creation/cloud-agents-row/build-agents-row-copy'
import { getWorktreeExecutionHostId } from '../../../../shared/execution-host'
import { agentName, keyPhrase } from '../settings/agent-accounts/orca-cloud-accounts-copy'
import { openAgentHostPanel } from './agent-host-panel-store'

/**
 * The ready-line wording, grouped by source: "Claude from your Orca account · Codex with the
 * team key"; agents nothing covers say so after the groups.
 */
export function agentsSummary(
  coverage: readonly { agent: OrcaCloudAccountAgent; coverage: OrcaCloudAgentCoverage }[],
  t: Translate
): string {
  const groups = new Map<'account' | AgentKeyKind, OrcaCloudAccountAgent[]>()
  const rest: string[] = []
  for (const entry of coverage) {
    const agent = agentName(entry.agent, t)
    switch (entry.coverage.kind) {
      case 'account':
      case 'key': {
        const via = entry.coverage.kind === 'key' ? entry.coverage.keyKind : 'account'
        groups.set(via, [...(groups.get(via) ?? []), entry.agent])
        break
      }
      case 'notSetUp':
        rest.push(t('agentHostPanel.summary.agentNotSetUp', '{{agent}} not set up', { agent }))
        break
      case 'expired':
        rest.push(t('agentHostPanel.summary.agentExpired', '{{agent}} sign-in expired', { agent }))
        break
      case 'killSwitch':
      case 'unavailable':
      case 'inWorkspace':
        rest.push(
          t('agentHostPanel.summary.agentSignsInHere', '{{agent}} signs in for this workspace', {
            agent
          })
        )
        break
    }
  }
  const parts = [...groups].map(([via, agents]) =>
    via === 'account'
      ? t('vmBuildAgents.groupAccount', '{{agents}} from your Orca account', {
          agents: agentList(agents, t)
        })
      : t('vmBuildAgents.groupKey', '{{agents}} with {{key}}', {
          agents: agentList(agents, t),
          key: keyPhrase(via, t)
        })
  )
  return [...parts, ...rest].join(t('vmBuildAgents.separator', ' · '))
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
      const worktree = (selectWorktreesByRepo(s)[repo.id] ?? []).find(
        (entry) => entry.id === workspaceId
      )
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
    ? agentsSummary(
        ORCA_CLOUD_ACCOUNT_AGENTS.map((agent) => ({
          agent,
          coverage: orcaCloudAgentCoverage(agent, status, accounts.keyKinds[agent])
        })),
        t
      )
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
