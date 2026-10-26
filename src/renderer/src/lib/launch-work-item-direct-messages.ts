import { toast } from 'sonner'
import { planAgentCliArgsSuffix } from './tui-agent-startup'
import { getAgentLabel } from './agent-catalog'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentStartupShell } from '../../../shared/tui-agent-startup-shell'
import { isGitLabIssueUrl } from '@/lib/new-workspace'
import { translate } from '@/i18n/i18n'

export type DirectLaunchIssueLike = {
  type: string
  number?: number | null
  url?: string
}

export function gitLabIssueNumber(item: DirectLaunchIssueLike): number | undefined {
  return item.type === 'issue' && item.number != null && item.url && isGitLabIssueUrl(item.url)
    ? item.number
    : undefined
}

export const resolvePrHeadErrorMessage = (): string =>
  translate('auto.lib.launch.work.item.direct.8bc45efdbc', 'Failed to resolve PR head.')

export const unavailableAgentErrorMessage = (): string =>
  translate(
    'auto.lib.launch.work.item.direct.19c7683acf',
    'Selected agent is not available in the created workspace.'
  )

export const workspaceActivationErrorMessage = (): string =>
  translate(
    'auto.lib.launch.work.item.direct.67e103dd60',
    'Workspace created but could not be activated.'
  )

export const agentLaunchCommandErrorMessage = (): string =>
  translate(
    'auto.lib.launch.work.item.direct.3de6371df3',
    'Could not build the agent launch command.'
  )

export function validateActionTerminalArgs(
  agent: TuiAgent,
  args: string | null | undefined,
  shell: AgentStartupShell,
  notify = true
): boolean {
  if (planAgentCliArgsSuffix(args, shell).ok) {
    return true
  }
  if (notify) {
    toast.error(
      translate(
        'settings.sourceControl.actionModel.invalidArgs',
        'The CLI arguments for {{value0}} are invalid. Fix them in Settings → Source Control AI.',
        { value0: getAgentLabel(agent) }
      )
    )
  }
  return false
}
