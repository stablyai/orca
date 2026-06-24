import type { Automation } from '../../../../shared/automations-types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import {
  describeRuntimeCompatBlock,
  evaluateRuntimeCompat
} from '../../../../shared/protocol-compat'
import {
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { ProjectHostSetup, Repo, Worktree } from '../../../../shared/types'
import type { TaskSourceHostAvailability } from '../task-source-context-summary'

export type AutomationTargetAvailability =
  | {
      canRunNow: true
      reason: 'available'
      message: null
    }
  | {
      canRunNow: false
      reason:
        | 'missing-project'
        | 'missing-project-host-setup'
        | 'project-host-setup-not-ready'
        | 'missing-workspace'
        | 'host-mismatch'
        | 'unsupported-host'
        | 'runtime-checking'
        | 'runtime-unavailable'
        | 'runtime-update-required'
        | 'ssh-auth-needed'
        | 'ssh-unavailable'
        | 'ssh-connecting'
        | 'source-auth-needed'
        | 'source-tool-unavailable'
        | 'source-provider-unsupported'
        | 'source-host-unavailable'
      message: string
    }

type AutomationTargetAvailabilityArgs = {
  automation: Automation
  repo: Repo | null | undefined
  workspace: Worktree | null | undefined
  projectHostSetups: readonly ProjectHostSetup[]
  sshConnectionStates: ReadonlyMap<string, Pick<SshConnectionState, 'status'>>
  runtimeStatusByEnvironmentId?: ReadonlyMap<
    string,
    { status: RuntimeStatus | null; checkedAt: number }
  >
  sourceHostAvailability?: readonly TaskSourceHostAvailability[]
}

export function getAutomationTargetAvailability({
  automation,
  repo,
  workspace,
  projectHostSetups,
  sshConnectionStates,
  runtimeStatusByEnvironmentId,
  sourceHostAvailability
}: AutomationTargetAvailabilityArgs): AutomationTargetAvailability {
  if (!repo) {
    return unavailable('missing-project', 'The target project is no longer available.')
  }
  if (automation.runContext) {
    const parsedHost = parseExecutionHostId(automation.runContext.hostId)
    if (parsedHost?.kind === 'runtime') {
      const runtimeAvailability = getRuntimeAutomationAvailability(
        parsedHost.environmentId,
        runtimeStatusByEnvironmentId
      )
      if (!runtimeAvailability.canRunNow) {
        return runtimeAvailability
      }
    }
    const setup = projectHostSetups.find(
      (candidate) => candidate.id === automation.runContext?.projectHostSetupId
    )
    if (!setup) {
      return unavailable(
        'missing-project-host-setup',
        'Project is not set up on the selected automation host anymore.'
      )
    }
    if (setup.setupState !== 'ready') {
      return unavailable(
        'project-host-setup-not-ready',
        `Project setup on the selected automation host is ${setup.setupState}.`
      )
    }
    if (
      setup.projectId !== automation.runContext.projectId ||
      setup.hostId !== automation.runContext.hostId ||
      setup.repoId !== automation.runContext.repoId ||
      setup.path !== automation.runContext.path ||
      automation.runContext.repoId !== repo.id ||
      automation.runContext.path !== repo.path ||
      automation.runContext.hostId !== getRepoExecutionHostId(repo)
    ) {
      return unavailable(
        'host-mismatch',
        'The saved run host no longer matches this project setup.'
      )
    }
  }
  if (automation.workspaceMode === 'existing' && !workspace) {
    return unavailable('missing-workspace', 'The target workspace is no longer available.')
  }

  const sourceAvailability = getAutomationSourceAvailability(
    automation.sourceContext,
    sourceHostAvailability
  )
  if (sourceAvailability) {
    return sourceAvailability
  }

  const sshTargetId = getAutomationSshTargetId(automation, repo)
  if (!sshTargetId) {
    return { canRunNow: true, reason: 'available', message: null }
  }

  const status = sshConnectionStates.get(sshTargetId)?.status ?? 'disconnected'
  switch (status) {
    case 'connected':
      return { canRunNow: true, reason: 'available', message: null }
    case 'auth-failed':
    case 'reconnection-failed':
      return unavailable('ssh-auth-needed', 'Connect this SSH host before running manually.')
    case 'connecting':
    case 'deploying-relay':
    case 'reconnecting':
      return unavailable('ssh-connecting', 'This SSH host is still connecting.')
    case 'disconnected':
    case 'error':
      return unavailable('ssh-unavailable', 'Connect this SSH host before running manually.')
  }
}

function getAutomationSourceAvailability(
  sourceContext: TaskSourceContext | null | undefined,
  sourceHostAvailability: readonly TaskSourceHostAvailability[] | undefined
): AutomationTargetAvailability | null {
  if (!sourceContext) {
    return null
  }
  const availability = sourceHostAvailability?.find(
    (entry) => entry.hostId === sourceContext.hostId
  )
  if (!availability) {
    return null
  }
  const providerLabel = getAutomationSourceProviderLabel(sourceContext.provider)
  switch (availability.reason) {
    case undefined:
      break
    case 'missing-provider-auth':
      return unavailable(
        'source-auth-needed',
        `Connect the saved ${providerLabel} source account before running manually.`
      )
    case 'unavailable-source-tool':
      return unavailable(
        'source-tool-unavailable',
        `Install or configure the ${providerLabel} source tool before running manually.`
      )
    case 'unsupported-provider':
    case 'missing-task-source-capability':
      return unavailable(
        'source-provider-unsupported',
        `The saved ${providerLabel} source is not supported on this automation host.`
      )
    case 'checking-task-source-capability':
      return unavailable(
        'source-host-unavailable',
        `Checking the saved ${providerLabel} source host before running manually.`
      )
  }
  if (
    availability.health === 'disconnected' ||
    availability.health === 'blocked' ||
    availability.health === 'error' ||
    availability.status === 'disconnected' ||
    availability.status === 'auth-failed' ||
    availability.status === 'reconnection-failed' ||
    availability.status === 'error'
  ) {
    return unavailable(
      'source-host-unavailable',
      `Reconnect the saved ${providerLabel} source host before running manually.`
    )
  }
  if (
    availability.health === 'connecting' ||
    availability.status === 'connecting' ||
    availability.status === 'deploying-relay' ||
    availability.status === 'reconnecting'
  ) {
    return unavailable(
      'source-host-unavailable',
      `The saved ${providerLabel} source host is still connecting.`
    )
  }
  return null
}

function getAutomationSourceProviderLabel(provider: TaskSourceContext['provider']): string {
  switch (provider) {
    case 'github':
      return 'GitHub'
    case 'gitlab':
      return 'GitLab'
    case 'gitea':
      return 'Gitea'
    case 'linear':
      return 'Linear'
    case 'jira':
      return 'Jira'
  }
}

function getRuntimeAutomationAvailability(
  environmentId: string,
  runtimeStatusByEnvironmentId:
    | ReadonlyMap<string, { status: RuntimeStatus | null; checkedAt: number }>
    | undefined
): AutomationTargetAvailability {
  const entry = runtimeStatusByEnvironmentId?.get(environmentId)
  if (!entry) {
    return unavailable(
      'runtime-checking',
      'Checking the selected remote server before running manually.'
    )
  }
  if (!entry.status) {
    return unavailable(
      'runtime-unavailable',
      'Reconnect this remote server before running manually.'
    )
  }
  if (entry.status.graphStatus !== 'ready') {
    return unavailable(
      'runtime-unavailable',
      'The selected remote server is not ready to run automations yet.'
    )
  }
  const compat = evaluateRuntimeCompat({
    clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
    serverProtocolVersion: entry.status.runtimeProtocolVersion ?? entry.status.protocolVersion,
    serverMinCompatibleClientProtocolVersion:
      entry.status.minCompatibleRuntimeClientVersion ?? entry.status.minCompatibleMobileVersion
  })
  if (compat.kind === 'blocked') {
    return unavailable('runtime-update-required', describeRuntimeCompatBlock(compat))
  }
  return { canRunNow: true, reason: 'available', message: null }
}

function getAutomationSshTargetId(automation: Automation, repo: Repo): string | null {
  const parsedHost = parseExecutionHostId(automation.runContext?.hostId)
  if (parsedHost?.kind === 'ssh') {
    return parsedHost.targetId
  }
  if (automation.executionTargetType === 'ssh' && automation.executionTargetId.trim()) {
    return automation.executionTargetId
  }
  return repo.connectionId?.trim() || null
}

function unavailable(
  reason: Exclude<AutomationTargetAvailability['reason'], 'available'>,
  message: string
): AutomationTargetAvailability {
  return { canRunNow: false, reason, message }
}
