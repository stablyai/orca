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
