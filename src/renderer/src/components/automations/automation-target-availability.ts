import {
  AUTOMATION_MISSING_AGENT_MESSAGE,
  type Automation
} from '../../../../shared/automations-types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import {
  describeRuntimeCompatBlock,
  evaluateRuntimeCompat
} from '../../../../shared/protocol-compat'
import {
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'
import type { AutomationHostTarget } from './automation-host-client'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { ProjectHostSetup, Repo, Worktree } from '../../../../shared/types'
import type { TaskSourceHostAvailability } from '../task-source-context-summary'
import { getAutomationSourceAvailability } from './automation-source-availability'

export type AutomationTargetAvailability =
  | {
      canRunNow: true
      reason: 'available'
      message: null
    }
  | {
      canRunNow: false
      reason:
        | 'missing-agent'
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
  automationHostTarget?: AutomationHostTarget | null
  sourceHostAvailability?: readonly TaskSourceHostAvailability[]
}

export function getAutomationTargetAvailability({
  automation,
  repo,
  workspace,
  projectHostSetups,
  sshConnectionStates,
  runtimeStatusByEnvironmentId,
  automationHostTarget,
  sourceHostAvailability
}: AutomationTargetAvailabilityArgs): AutomationTargetAvailability {
  // Why: a retired id persisted by an older host is truthy but unlaunchable.
  if (!isTuiAgent(automation.agentId)) {
    return unavailable('missing-agent', AUTOMATION_MISSING_AGENT_MESSAGE)
  }
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
    // Why: projectId is a derived identity that upgrades over time (repo:→git:→github:);
    // matching on it strands automations created before their repo's identity resolved.
    // Anchor on repoId/path/host instead — the durable, stable target identity.
    const setupMatchesContext =
      setup.repoId === automation.runContext.repoId &&
      setup.path === automation.runContext.path &&
      setupHostMatchesRunContext(setup.hostId, automation.runContext.hostId, automationHostTarget)
    const repoMatchesContext =
      automation.runContext.repoId === repo.id &&
      automation.runContext.path === repo.path &&
      repoHostMatchesRunContext(repo, automation.runContext.hostId, automationHostTarget)
    if (!setupMatchesContext || !repoMatchesContext) {
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

function getRuntimeTargetHostId(target: AutomationHostTarget | null | undefined): string | null {
  return target?.kind === 'environment'
    ? `runtime:${encodeURIComponent(target.environmentId)}`
    : null
}

function setupHostMatchesRunContext(
  setupHostId: string,
  runHostId: string,
  target: AutomationHostTarget | null | undefined
): boolean {
  if (setupHostId === runHostId) {
    return true
  }
  const targetHostId = getRuntimeTargetHostId(target)
  // Why: remote-runtime project lists project the server-local host as runtime:<env>,
  // while CLI-created automations can preserve the server's durable local run host.
  return targetHostId !== null && setupHostId === targetHostId && runHostId === 'local'
}

function repoHostMatchesRunContext(
  repo: Repo,
  runHostId: string,
  target: AutomationHostTarget | null | undefined
): boolean {
  if (runHostId === getRepoExecutionHostId(repo)) {
    return true
  }
  const targetHostId = getRuntimeTargetHostId(target)
  // Why: repos fetched from a remote runtime are owned by runtime:<env> in the
  // renderer, but saved automations still target the host setup that runs there.
  return targetHostId !== null && getRepoExecutionHostId(repo) === targetHostId
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
