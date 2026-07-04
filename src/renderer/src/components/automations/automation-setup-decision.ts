import type { AutomationWorkspaceMode } from '../../../../shared/automations-types'
import type {
  OrcaHooks,
  ProjectHostSetup,
  Repo,
  SetupDecision,
  SetupRunPolicy
} from '../../../../shared/types'
import { getSetupConfig } from '@/lib/new-workspace'

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
  const setup = projectHostSetups.find(
    (candidate) => candidate.repoId === repoId && candidate.setupState === 'ready'
  )
  const repo = repos.find((candidate) => candidate.id === repoId)
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

export function getAutomationSetupDefaultDecision(
  source: Pick<AutomationSetupSource, 'setupRunPolicy'> | null
): Extract<SetupDecision, 'run' | 'skip'> | undefined {
  if (!source) {
    return undefined
  }
  return source.setupRunPolicy === 'run-by-default' ? 'run' : 'skip'
}

export function getVisibleAutomationSetupDecision(args: {
  createTarget: 'orca' | 'hermes'
  workspaceMode: AutomationWorkspaceMode
  repoId: string
  repos: readonly Repo[]
  projectHostSetups: readonly ProjectHostSetup[]
  yamlHooks?: OrcaHooks | null
}): Extract<SetupDecision, 'run' | 'skip'> | undefined {
  if (args.createTarget !== 'orca' || args.workspaceMode !== 'new_per_run') {
    return undefined
  }
  return getAutomationSetupDefaultDecision(
    getAutomationSetupSource(args.repoId, args.repos, args.projectHostSetups, args.yamlHooks)
  )
}

export function resolveAutomationSetupDecisionForSave(args: {
  createTarget: 'orca' | 'hermes'
  workspaceMode: AutomationWorkspaceMode
  repoId: string
  repos: readonly Repo[]
  projectHostSetups: readonly ProjectHostSetup[]
  yamlHooks?: OrcaHooks | null
  draftSetupDecision: Extract<SetupDecision, 'run' | 'skip'> | undefined
}): Extract<SetupDecision, 'run' | 'skip'> | undefined {
  if (args.createTarget !== 'orca' || args.workspaceMode !== 'new_per_run') {
    return undefined
  }

  const visibleDefault = getVisibleAutomationSetupDecision(args)
  if (visibleDefault) {
    return args.draftSetupDecision ?? visibleDefault
  }

  if (args.yamlHooks === undefined) {
    // Why: automations cannot pause later for an orca.yaml trust prompt; when
    // hook inspection is unavailable, fail closed instead of inheriting setup.
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
  // Why: legacy new-run automations had no saved choice and now dispatch as
  // skip for compatibility; editing them must not silently opt into setup.
  return args.workspaceMode === 'new_per_run' ? 'skip' : undefined
}
