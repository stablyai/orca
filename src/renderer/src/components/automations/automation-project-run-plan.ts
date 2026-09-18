import type { Automation, AutomationCreateInput } from '../../../../shared/automations-types'
import type { AutomationAuthorityRef } from '../../../../shared/automation-owner-ref'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceRunContext } from '../../../../shared/task-source-context'
import type { AutomationWorkspaceMode } from '../../../../shared/automations-types'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { useAppStore } from '@/store'
import type { AutomationDraft } from './AutomationEditorDialog'
import { createAutomationOnDestination } from './automation-orca-save-operations'
import { buildAutomationRunContextForRepo } from './automation-run-context'
import type { AutomationSaveContext } from './automation-save-context'
import { resolveAutomationSetupDecisionForSave } from './automation-setup-decision'

export type AutomationCreateTargets = {
  extraProjectIds: string[]
  workspaceMode: AutomationWorkspaceMode
}

/**
 * The save-boundary view of a create draft: extras never repeat the primary, and
 * once any extra exists every record runs in a fresh workspace.
 */
export function normalizeAutomationCreateTargets(
  draft: Pick<AutomationDraft, 'projectId' | 'extraProjectIds' | 'workspaceMode'>
): AutomationCreateTargets {
  const extraProjectIds = [...new Set(draft.extraProjectIds)].filter((id) => id !== draft.projectId)
  return {
    extraProjectIds,
    workspaceMode: extraProjectIds.length > 0 ? 'new_per_run' : draft.workspaceMode
  }
}

export type AutomationProjectRunPlan = {
  setupDecision: AutomationDraft['setupDecision']
  runContext: WorkspaceRunContext
}

/** Resolves one project's setup decision (with its trust prompt) and run context. */
export async function planAutomationProjectRun(
  context: AutomationSaveContext,
  args: {
    projectId: string
    repos: readonly Repo[]
    authority: AutomationAuthorityRef | null
    workspaceMode: AutomationWorkspaceMode
    draftSetupDecision: AutomationDraft['setupDecision']
  }
): Promise<AutomationProjectRunPlan | null> {
  const { projectId, repos, authority, workspaceMode, draftSetupDecision } = args
  const setupHostId =
    authority?.kind === 'runtime' ? toRuntimeExecutionHostId(authority.environmentId) : undefined
  const projectHostSetups = setupHostId
    ? context.store.projectHostSetups.filter(
        (candidate) => candidate.repoId !== projectId || candidate.hostId === setupHostId
      )
    : context.store.projectHostSetups
  let setupDecision = resolveAutomationSetupDecisionForSave({
    createTarget: context.local.createTarget,
    workspaceMode,
    repoId: projectId,
    repos,
    projectHostSetups,
    yamlHooks:
      workspaceMode === 'new_per_run'
        ? await context.setup.loadAutomationYamlHooksForRepo(projectId, setupHostId)
        : null,
    draftSetupDecision
  })
  if (setupDecision === 'run') {
    const trust = await ensureHooksConfirmed(
      useAppStore.getState(),
      projectId,
      'setup',
      setupHostId
    )
    if (trust === 'skip') {
      setupDecision = 'skip'
    }
  }
  const runContext = buildAutomationRunContextForRepo({
    repoId: projectId,
    repos,
    projectHostSetups
  })
  return runContext ? { setupDecision, runContext } : null
}

export type AutomationExtraProjectCopies = {
  created: Automation[]
  /** Display names of projects that got no copy. */
  failed: string[]
}

/** Creates one copy of a just-saved automation per extra project, each in a fresh workspace. */
export async function createAutomationCopiesForExtraProjects(
  context: AutomationSaveContext,
  extraProjectIds: readonly string[],
  createInput: AutomationCreateInput
): Promise<AutomationExtraProjectCopies> {
  const { repos } = context.store
  const { draft } = context.local
  const { createDestination, invalidateWrittenHost } = context.destination
  const copies: AutomationExtraProjectCopies = { created: [], failed: [] }
  for (const projectId of extraProjectIds) {
    const name = repos.find((repo) => repo.id === projectId)?.displayName ?? projectId
    const checked = createDestination.check(projectId)
    if (!checked.ok) {
      copies.failed.push(name)
      continue
    }
    const plan = await planAutomationProjectRun(context, {
      projectId,
      repos,
      authority: checked.destination.authority,
      workspaceMode: 'new_per_run',
      draftSetupDecision: draft.setupDecision
    })
    if (!plan) {
      copies.failed.push(name)
      continue
    }
    const saved = await createAutomationOnDestination(
      checked.destination.authority,
      {
        ...createInput,
        projectId,
        runContext: plan.runContext,
        setupDecision: plan.setupDecision,
        workspaceMode: 'new_per_run',
        workspaceId: '',
        baseBranch: null,
        reuseSession: false
      },
      checked.destination,
      invalidateWrittenHost
    )
    if (saved.ok) {
      copies.created.push(saved.value)
    } else {
      copies.failed.push(name)
    }
  }
  return copies
}
