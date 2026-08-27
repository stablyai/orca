import type { Automation } from '../../../../shared/automations-types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { AutomationHostTarget } from './automation-host-client'

export function getRuntimeTargetHostId(
  target: AutomationHostTarget | null | undefined
): string | null {
  return target?.kind === 'environment'
    ? `runtime:${encodeURIComponent(target.environmentId)}`
    : null
}

export function setupHostMatchesRunContext(
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

export function repoHostMatchesRunContext(
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

export function getAutomationSshTargetId(automation: Automation, repo: Repo): string | null {
  const parsedHost = parseExecutionHostId(automation.runContext?.hostId)
  if (parsedHost?.kind === 'ssh') {
    return parsedHost.targetId
  }
  if (automation.executionTargetType === 'ssh' && automation.executionTargetId.trim()) {
    return automation.executionTargetId
  }
  return repo.connectionId?.trim() || null
}
