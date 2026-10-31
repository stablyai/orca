import type { Automation } from './automations-types'
import type { Repo } from './repo-types'
import type { WorkspaceRunContext } from './task-source-context'
import { getRepoExecutionHostId, isRepoSshOnlyHost, parseExecutionHostId } from './execution-host'

/** A captured target names a row; a legacy bare id must resolve uniquely. */
export function findAutomationRepo<
  T extends Pick<Repo, 'id' | 'path' | 'connectionId' | 'executionHostId'>
>(
  repos: readonly T[],
  repoId: string,
  context?: Pick<WorkspaceRunContext, 'hostId' | 'path'> | null,
  incomingRuntimeAlias = false
): T | undefined {
  const host = context ? parseExecutionHostId(context.hostId) : null
  const runtimeAlias = incomingRuntimeAlias && host?.kind === 'runtime'
  const hostId = runtimeAlias ? 'local' : host?.id
  const matches = repos.filter(
    (repo) =>
      repo.id === repoId &&
      (!context ||
        ((runtimeAlias || repo.path === context.path) && getRepoExecutionHostId(repo) === hostId))
  )
  return matches.length === 1 ? matches[0] : undefined
}

export function findAutomationRepoForWrite(
  repos: readonly Repo[],
  repoId: string,
  context: Pick<WorkspaceRunContext, 'hostId' | 'path'> | null | undefined,
  resolvedRepo?: Repo,
  incomingRuntimeAlias = true
): Repo | undefined {
  return findAutomationRepo(
    repos,
    repoId,
    resolvedRepo
      ? { hostId: getRepoExecutionHostId(resolvedRepo), path: resolvedRepo.path }
      : context,
    !resolvedRepo && incomingRuntimeAlias
  )
}

export function automationRequiresHostReselection(
  automation: Automation,
  repos: readonly Repo[]
): boolean {
  const repo = findAutomationRepo(
    repos,
    automation.runContext?.repoId ?? automation.projectId,
    automation.runContext
  )
  return (
    automation.executionTargetType === 'local' &&
    automation.executionTargetId === 'local' &&
    automation.executionTargetGeneration === undefined &&
    automation.runContext !== undefined &&
    !!repo &&
    isRepoSshOnlyHost(repo)
  )
}
