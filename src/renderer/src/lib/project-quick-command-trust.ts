import { useAppStore } from '@/store'
import {
  getProjectTerminalQuickCommands,
  getTerminalQuickCommandScope,
  isProjectTerminalQuickCommand,
  terminalQuickCommandListsMatch
} from '../../../shared/terminal-quick-commands'
import type { OrcaHooks, TerminalQuickCommand } from '../../../shared/types'
import { ensureHooksConfirmed } from './ensure-hooks-confirmed'
import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'

/**
 * Gate execution of orca.yaml-provided quick commands behind the repo trust
 * prompt. Personal commands pass through unchanged; project commands ask once
 * per repo and re-prompt when the file's quick commands change.
 *
 * Returns the command to execute, or null when execution must not happen.
 * For project commands the returned command is re-projected from the same
 * orca.yaml read the trust hash covered — the cached menu copy may be stale
 * (the file can change between menu load and click), and executing it would
 * run content the trust prompt never showed.
 */
export async function ensureProjectQuickCommandTrusted(
  command: TerminalQuickCommand
): Promise<TerminalQuickCommand | null> {
  if (!isProjectTerminalQuickCommand(command)) {
    return command
  }
  const scope = getTerminalQuickCommandScope(command)
  if (scope.type !== 'repo') {
    // Fail closed: a project command without a repo scope cannot be trust-checked.
    return null
  }
  const state = useAppStore.getState()
  const owners = state.repos.filter((repo) => repo.id === scope.repoId)
  // Fail closed: a missing/ambiguous bare repo id cannot be routed to one owner
  // host. A click from a stale menu must not inspect another host's command.
  if (owners.length !== 1) {
    return null
  }
  const ownerIdentity = getRepoHostIdentity(owners[0])
  let inspectedHooks: OrcaHooks | null | undefined
  const decision = await ensureHooksConfirmed(
    state,
    scope.repoId,
    'quickCommands',
    undefined,
    undefined,
    {
      onSharedHooksInspected: (yamlHooks) => {
        inspectedHooks = yamlHooks
      }
    }
  )
  if (decision !== 'run') {
    return null
  }
  if (inspectedHooks === undefined) {
    // Fail closed: project execution must use content from the inspected read.
    return null
  }
  const fresh = getProjectTerminalQuickCommands(inspectedHooks?.quickCommands, scope.repoId)
  const currentOwners = useAppStore.getState().repos.filter((repo) => repo.id === scope.repoId)
  if (currentOwners.length !== 1 || getRepoHostIdentity(currentOwners[0]) !== ownerIdentity) {
    // Why: the trust prompt can outlive repo removal or owner replacement;
    // content inspected on the old host must never execute in the new context.
    return null
  }
  // Keep the menu cache honest: it should reflect the read the user just acted
  // on. Guard the owner identity so removal/replacement during the prompt can't
  // resurrect an orphaned bucket or publish one host's commands for another.
  useAppStore.setState((s) => {
    const currentOwners = s.repos.filter((repo) => repo.id === scope.repoId)
    if (currentOwners.length !== 1 || getRepoHostIdentity(currentOwners[0]) !== ownerIdentity) {
      return s
    }
    if (
      s.projectQuickCommandOwnerByRepo[scope.repoId] === ownerIdentity &&
      terminalQuickCommandListsMatch(s.projectQuickCommandsByRepo[scope.repoId], fresh)
    ) {
      return s
    }
    return {
      projectQuickCommandsByRepo: { ...s.projectQuickCommandsByRepo, [scope.repoId]: fresh },
      projectQuickCommandOwnerByRepo: {
        ...s.projectQuickCommandOwnerByRepo,
        [scope.repoId]: ownerIdentity
      }
    }
  })
  return fresh.find((candidate) => candidate.id === command.id) ?? null
}
