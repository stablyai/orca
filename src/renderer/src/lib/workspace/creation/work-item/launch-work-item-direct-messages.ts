import { toast } from 'sonner'
import { notifyAgentLaunchFailure } from '@/lib/agent-session/launch/failure/agent-launch-failure'
import {
  planAgentCliArgsSuffix,
  type AgentStartupShell
} from '../../../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { getAgentLabel } from '../../../agent-catalog/agent-catalog'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'

import '@/lib/workspace/creation/new-workspace'
import { isGitLabIssueUrl } from '../../../../../../shared/new-workspace/workspace-source'
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
  translate(
    'auto.lib.launch.work.item.direct.8bc45efdbc',
    'Could not read the pull request. Check that you can open it, then try again.'
  )

export const unavailableAgentErrorMessage = (): string =>
  translate(
    'auto.lib.launch.work.item.direct.19c7683acf',
    'The selected agent is unavailable. Check the workspace’s agent settings, then try again.'
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

export function invalidTerminalArgsMessage(
  agent: TuiAgent,
  args: string | null | undefined,
  shell: AgentStartupShell
): string | null {
  return planAgentCliArgsSuffix(args, shell).ok
    ? null
    : translate(
        'agentLaunch.invalidArgs',
        'The CLI arguments for {{value0}} have an unclosed quote. Fix them, then try again.',
        { value0: getAgentLabel(agent) }
      )
}

export function directWorkItemFailureReporter(
  onFailureNotified?: () => void,
  getAgent?: () => TuiAgent | undefined
) {
  return (message: string): false => {
    const agent = getAgent?.()
    if (agent) {
      notifyAgentLaunchFailure(agent, message)
    } else {
      toast.error(message)
    }
    onFailureNotified?.()
    return false
  }
}
