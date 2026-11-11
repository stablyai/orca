// S1-b: the Agents row's ⋯ menu. Source per agent "in this workspace" (the per-workspace override),
// then the way into Settings → Agent accounts. Before S0 it offers the key path instead.
import React from 'react'
import { MoreHorizontal } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  ORCA_CLOUD_ACCOUNT_AGENTS,
  isUsableAgentCredential,
  type AgentKeyKind,
  type AgentSource,
  type AgentSourcesView,
  type OrcaCloudAccountAgent,
  type OrcaCloudAgentsStatus
} from '../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { agentName, keyOptionLabel } from '../../settings/agent-accounts/orca-cloud-accounts-copy'

/** This workspace's Sources: none until the sandbox exists (there is no workspace to name yet). */
export type WorkspaceSourcesLoad =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'failed' }
  | { kind: 'ready'; view: AgentSourcesView }

export type VmBuildCloudAgentsMenuProps = {
  /** R2 (nothing set up): the key path and Manage only. */
  offer: boolean
  status: OrcaCloudAgentsStatus | null
  keyKinds: Record<OrcaCloudAccountAgent, AgentKeyKind | null>
  sources: WorkspaceSourcesLoad
  onOpen: () => void
  onChoose: (agent: OrcaCloudAccountAgent, source: Exclude<AgentSource, null>) => void
  onManage: () => void
  onUseKey: () => void
}

function chosen(view: AgentSourcesView, agent: OrcaCloudAccountAgent): AgentSource {
  return view.effective?.[agent]?.source ?? view.defaults[agent] ?? null
}

export function VmBuildCloudAgentsMenu({
  offer,
  status,
  keyKinds,
  sources,
  onOpen,
  onChoose,
  onManage,
  onUseKey
}: VmBuildCloudAgentsMenuProps): React.JSX.Element {
  const t = useTranslate()
  const view = sources.kind === 'ready' ? sources.view : null
  const shared = view?.sharedWorkspace === true
  const note =
    sources.kind === 'none'
      ? t('vmBuildAgents.menu.notYet', 'You can choose once the sandbox is created.')
      : sources.kind === 'failed'
        ? t('vmBuildAgents.menu.failed', 'Couldn’t read this workspace’s choice.')
        : shared
          ? t('vmBuildAgents.menu.shared', 'Personal accounts aren’t used in shared workspaces.')
          : null
  const agents = offer
    ? []
    : ORCA_CLOUD_ACCOUNT_AGENTS.filter(
        (agent) =>
          status !== null &&
          (status.sources.coveredByKey[agent] ||
            isUsableAgentCredential(status.credentials[agent].state))
      )
  return (
    <DropdownMenu onOpenChange={(open) => (open ? onOpen() : undefined)}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('vmBuildAgents.menu.label', 'Agent sign-in options')}
        >
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {agents.map((agent) => {
          const usable =
            status !== null &&
            status.credentials.providerEnabled[agent] &&
            isUsableAgentCredential(status.credentials[agent].state)
          const keyKind = status?.sources.coveredByKey[agent] ? (keyKinds[agent] ?? 'team') : null
          const disabled = view === null || shared
          return (
            <React.Fragment key={agent}>
              <DropdownMenuLabel>
                {t('vmBuildAgents.menu.inThisWorkspace', '{{agent}} in this workspace', {
                  agent: agentName(agent, t)
                })}
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={view ? (chosen(view, agent) ?? '') : ''}
                onValueChange={(value) => {
                  if (value === 'sign-in' || value === 'key') {
                    onChoose(agent, value)
                  }
                }}
              >
                <DropdownMenuRadioItem value="sign-in" disabled={disabled || !usable}>
                  {t('vmBuildAgents.menu.yourAccount', 'Your account')}
                </DropdownMenuRadioItem>
                {keyKind ? (
                  <DropdownMenuRadioItem value="key" disabled={disabled}>
                    {keyOptionLabel(keyKind, t)}
                  </DropdownMenuRadioItem>
                ) : null}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
            </React.Fragment>
          )
        })}
        {agents.length > 0 && note ? (
          <>
            <p className="px-2 pb-1.5 text-xs text-muted-foreground">{note}</p>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {offer ? (
          <DropdownMenuItem onSelect={onUseKey}>
            {t('vmBuildAgents.menu.useKey', 'Use an API key instead')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={onManage}>
          {t('vmBuildAgents.menu.manage', 'Manage agent accounts…')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
