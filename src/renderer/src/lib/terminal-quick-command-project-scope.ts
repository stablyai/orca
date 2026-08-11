import type { ExecutionHostId } from '../../../shared/execution-host'
import { getTerminalQuickCommandScope } from '../../../shared/terminal-quick-commands'
import type { ProjectHostSetup, TerminalQuickCommand } from '../../../shared/types'

type TerminalQuickCommandProjectContext = {
  commandHostId: ExecutionHostId
  projectHostSetups: readonly Pick<ProjectHostSetup, 'hostId' | 'projectId' | 'repoId'>[]
  targetHostId: ExecutionHostId
  targetRepoId: string | null
}

type ProjectResolution =
  | { kind: 'resolved'; projectId: string }
  | { kind: 'ambiguous' }
  | { kind: 'unknown' }

function resolveProject(
  setups: TerminalQuickCommandProjectContext['projectHostSetups'],
  hostId: ExecutionHostId,
  repoId: string,
  allowAnyHostFallback: boolean
): ProjectResolution {
  const hostMatches = setups.filter((setup) => setup.hostId === hostId && setup.repoId === repoId)
  // Why: commands belong to a settings host, while its repo can execute through that host's SSH.
  const candidates =
    hostMatches.length > 0 || !allowAnyHostFallback
      ? hostMatches
      : setups.filter((s) => s.repoId === repoId)
  const projectIds = new Set(candidates.map((setup) => setup.projectId))
  if (projectIds.size === 0) {
    return { kind: 'unknown' }
  }
  if (projectIds.size > 1) {
    return { kind: 'ambiguous' }
  }
  return { kind: 'resolved', projectId: [...projectIds][0] }
}

export function terminalQuickCommandMatchesWorkspaceProject(
  command: TerminalQuickCommand,
  context: TerminalQuickCommandProjectContext
): boolean {
  const scope = getTerminalQuickCommandScope(command)
  if (scope.type === 'global') {
    return true
  }
  if (context.targetRepoId === null) {
    return false
  }
  if (context.commandHostId === context.targetHostId && scope.repoId === context.targetRepoId) {
    return true
  }

  const commandProject = resolveProject(
    context.projectHostSetups,
    context.commandHostId,
    scope.repoId,
    true
  )
  const targetProject = resolveProject(
    context.projectHostSetups,
    context.targetHostId,
    context.targetRepoId,
    false
  )
  if (commandProject.kind === 'ambiguous' || targetProject.kind === 'ambiguous') {
    return false
  }
  if (commandProject.kind === 'resolved' && targetProject.kind === 'resolved') {
    return commandProject.projectId === targetProject.projectId
  }
  return scope.repoId === context.targetRepoId
}
