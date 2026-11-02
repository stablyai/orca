import { getAutomationSetupDefaultDecision } from '../../../../shared/automation-setup-decision'
export { getAutomationSetupDefaultDecision } from '../../../../shared/automation-setup-decision'
import type { AutomationWorkspaceMode } from '../../../../shared/automations-types'
import type { OrcaHooks, SetupRunPolicy } from '../../../../shared/orca-yaml-hook-types'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { SetupDecision } from '../../../../shared/worktree/create-types'
import { findAutomationRepo } from '../../../../shared/automation-repo-target'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { getSetupConfig } from '../../../../shared/orca-hook-setup-config'

type AutomationSetupSource = {
  setupScript: string
  setupRunPolicy: SetupRunPolicy
}

function getAutomationSetupSource(
  repoId: string,
  repos: readonly Repo[],
  projectHostSetups: readonly ProjectHostSetup[],
  yamlHooks: OrcaHooks | null | undefined
): AutomationSetupSource | null {
  const repo = findAutomationRepo(repos, repoId)
  if (!repo) {
    return null
  }
  const setup = projectHostSetups.find(
    (candidate) =>
      candidate.repoId === repoId &&
      candidate.setupState === 'ready' &&
      candidate.hostId === getRepoExecutionHostId(repo) &&
      candidate.path === repo.path
  )
  const hookSettings = setup?.hookSettings ?? repo?.hookSettings
  const setupConfig = getSetupConfig(
    hookSettings ? { hookSettings } : repo,
    yamlHooks === undefined ? null : yamlHooks
  )
  if (!setupConfig) {
    return null
  }
  return {
    setupScript: setupConfig.command,
    setupRunPolicy: hookSettings?.setupRunPolicy ?? 'run-by-default'
  }
}

export function getVisibleAutomationSetupDecision(args: {
  workspaceMode: AutomationWorkspaceMode
  repoId: string
  repos: readonly Repo[]
  projectHostSetups: readonly ProjectHostSetup[]
  yamlHooks?: OrcaHooks | null
}): Extract<SetupDecision, 'run' | 'skip'> | undefined {
  if (args.workspaceMode !== 'new_per_run') {
    return undefined
  }
  return getAutomationSetupDefaultDecision(
    getAutomationSetupSource(args.repoId, args.repos, args.projectHostSetups, args.yamlHooks)
  )
}

export function resolveAutomationSetupDecisionForSave(args: {
  workspaceMode: AutomationWorkspaceMode
  repoId: string
  repos: readonly Repo[]
  projectHostSetups: readonly ProjectHostSetup[]
  yamlHooks?: OrcaHooks | null
  draftSetupDecision: Extract<SetupDecision, 'run' | 'skip'> | undefined
}): Extract<SetupDecision, 'run' | 'skip'> | undefined {
  if (args.workspaceMode !== 'new_per_run') {
    return undefined
  }

  const visibleDefault = getVisibleAutomationSetupDecision(args)
  if (visibleDefault) {
    return args.draftSetupDecision ?? visibleDefault
  }

  if (args.yamlHooks === undefined) {
    // Automations cannot pause for later hook trust; failed inspection must skip setup.
    return 'skip'
  }

  return undefined
}

export function getAutomationSetupDecisionDraftValue(args: {
  workspaceMode: AutomationWorkspaceMode
  persistedSetupDecision: SetupDecision | undefined
}): Extract<SetupDecision, 'run' | 'skip'> | undefined {
  if (args.persistedSetupDecision === 'run' || args.persistedSetupDecision === 'skip') {
    return args.persistedSetupDecision
  }
  // Legacy new-per-run records default to skip; editing must not silently opt them into setup.
  return args.workspaceMode === 'new_per_run' ? 'skip' : undefined
}
