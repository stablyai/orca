import { folderWorkspaceToWorktree } from '../../../shared/folder-workspace-worktree'
import { findAutomationRepo } from '../../../shared/automation-repo-target'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type {
  Automation,
  AutomationDispatchResult,
  AutomationPrecheckResult,
  AutomationRun
} from '../../../shared/automations-types'
import { getAutomationRunRepoId } from '../../../shared/automation-run-identity'
import {
  didAutomationPrecheckPass,
  formatAutomationPrecheckFailure
} from '../../../shared/automation-precheck'
import { getRepoSshConnectionId, parseExecutionHostId } from '../../../shared/execution-host'
import { resolveQualifiedFolderWorkspaceResult } from '../../../shared/folder-workspace-execution-host'
import { buildClientAutomationWorkspaceProvenance } from '../../../shared/automation-workspace-provenance'
import type { Worktree } from '../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  createRepoRowExecutionHostLookup,
  resolveWorktreeExecutionHost
} from '../../../shared/worktree-execution-host-resolution'

type AutomationDispatchStoreState = ReturnType<typeof useAppStore.getState>
type MarkDispatchResult = (result: AutomationDispatchResult) => Promise<void>

export type AutomationDispatchWorkspaceContext = {
  workspaceId: string | null
  workspaceDisplayName: string | null
  precheckResult: AutomationPrecheckResult | null
  sshTargetId?: string | null
}

export function resolveAutomationDispatchWorkspace(
  state: AutomationDispatchStoreState,
  automation: Automation,
  run: AutomationRun
) {
  const runRepoId = getAutomationRunRepoId(automation)
  const repo = findAutomationRepo(state.repos, runRepoId, automation.runContext)
  const automationWorkspaceScope = parseWorkspaceKey(automation.workspaceId ?? '')
  const folderTarget =
    automationWorkspaceScope?.type === 'folder'
      ? resolveQualifiedFolderWorkspaceResult(state, automationWorkspaceScope.folderWorkspaceId)
      : null
  const expectedHostId = automation.runContext?.hostId
  const repoOwners = createRepoRowExecutionHostLookup(state.repos)
  const automationWorktree = automation.workspaceId
    ? folderTarget
      ? folderTarget.kind === 'selected'
        ? folderWorkspaceToWorktree({
            ...folderTarget.value.workspace,
            executionHostId: folderTarget.value.hostId
          })
        : null
      : state.allWorktrees().find((entry) => {
          if (entry.id !== automation.workspaceId) {
            return false
          }
          if (!automation.runContext) {
            return true
          }
          const owner = resolveWorktreeExecutionHost(repoOwners, entry)
          return owner.kind === 'resolved' && owner.hostId === expectedHostId
        })
    : null
  const context: AutomationDispatchWorkspaceContext = {
    workspaceId: automation.workspaceId,
    workspaceDisplayName: automationWorktree?.displayName ?? run.workspaceDisplayName ?? null,
    precheckResult: null
  }
  return { runRepoId, repo, automationWorkspaceScope, automationWorktree, folderTarget, context }
}

type ResolvedAutomationDispatchWorkspace = ReturnType<typeof resolveAutomationDispatchWorkspace>

export async function prepareAutomationDispatchWorkspace(args: {
  state: AutomationDispatchStoreState
  automation: Automation
  run: AutomationRun
  dispatchToken: string
  resolved: ResolvedAutomationDispatchWorkspace & {
    repo: NonNullable<ResolvedAutomationDispatchWorkspace['repo']>
  }
  markDispatchResult: MarkDispatchResult
}): Promise<Worktree | null> {
  const { state, automation, run, dispatchToken, resolved, markDispatchResult } = args
  const { repo, runRepoId, automationWorkspaceScope, context } = resolved
  const folderTarget =
    automationWorkspaceScope?.type === 'folder'
      ? resolved.automationWorktree?.hostId
        ? resolveQualifiedFolderWorkspaceResult(
            state,
            automationWorkspaceScope.folderWorkspaceId,
            resolved.automationWorktree.hostId
          )
        : resolved.folderTarget
      : null
  const folder = folderTarget?.kind === 'selected' ? folderTarget.value : null
  const automationWorktree = folder
    ? folderWorkspaceToWorktree({ ...folder.workspace, executionHostId: folder.hostId })
    : folderTarget
      ? null
      : resolved.automationWorktree
  const workspaceOwner = automationWorktree
    ? resolveWorktreeExecutionHost(
        createRepoRowExecutionHostLookup(state.repos),
        automationWorktree
      )
    : null
  const workspaceMatchesRunTarget =
    automationWorkspaceScope?.type === 'folder'
      ? !!folder
      : !automation.runContext?.repoId ||
        (automationWorktree?.repoId === automation.runContext.repoId &&
          workspaceOwner?.kind === 'resolved' &&
          workspaceOwner.hostId === automation.runContext.hostId)
  if (automation.workspaceMode === 'existing' && automationWorktree && !workspaceMatchesRunTarget) {
    await markDispatchResult({
      runId: run.id,
      status: 'skipped_unavailable',
      workspaceId: automation.workspaceId,
      workspaceDisplayName: context.workspaceDisplayName,
      error: translate(
        'auto.hooks.useAutomationDispatchEvents.3ad7d77f57',
        'The target workspace is on a different host than this automation run target.'
      )
    })
    return null
  }
  const sshTargetId =
    automationWorkspaceScope?.type === 'folder'
      ? (folder?.connectionId ?? null)
      : getRepoSshConnectionId(repo)
  context.sshTargetId = sshTargetId
  if (
    automation.workspaceMode === 'new_per_run' &&
    !(await connectAutomationDispatchWorkspace({ run, context, markDispatchResult }))
  ) {
    return null
  }

  if (automation.workspaceMode === 'existing' && !automationWorktree) {
    await markDispatchResult({
      runId: run.id,
      status: 'skipped_unavailable',
      workspaceId: automation.workspaceId,
      workspaceDisplayName: context.workspaceDisplayName,
      error:
        folderTarget?.kind === 'ambiguous'
          ? translate(
              'auto.hooks.useAutomationDispatchEvents.workspaceHostUnresolved',
              'The target workspace spans more than one host, so this run has no single host to use.'
            )
          : translate(
              'auto.hooks.useAutomationDispatchEvents.59718b120b',
              'The target workspace is no longer available.'
            )
    })
    return null
  }

  if (run.trigger === 'scheduled' && automation.precheck) {
    context.precheckResult = await window.api.automations.runPrecheck({
      automationId: automation.id,
      runId: run.id
    })
    if (context.precheckResult && !didAutomationPrecheckPass(context.precheckResult)) {
      await markDispatchResult({
        runId: run.id,
        status: 'skipped_precheck',
        workspaceId: context.workspaceId,
        workspaceDisplayName: context.workspaceDisplayName,
        precheckResult: context.precheckResult,
        error: formatAutomationPrecheckFailure(context.precheckResult)
      })
      return null
    }
  }

  const automationWorkspaceCreateRequestId = createBrowserUuid()
  const createResult =
    automation.workspaceMode === 'new_per_run'
      ? await useAppStore.getState().createWorktree(
          runRepoId,
          buildAutomationWorkspaceName(run.title, run.scheduledFor),
          automation.baseBranch ?? undefined,
          automation.setupDecision ?? 'skip',
          undefined,
          'unknown',
          run.title,
          undefined,
          undefined,
          undefined,
          // The automation owns its prompt-bearing tab; createdWithAgent would reopen an empty fallback.
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          {
            // Why: only a captured host; with none, a project two hosts publish refuses, never guesses.
            executionHostId: parseExecutionHostId(automation.runContext?.hostId)?.id,
            automationProvenanceRequest: {
              automationId: automation.id,
              automationRunId: run.id,
              dispatchToken,
              createRequestId: automationWorkspaceCreateRequestId
            },
            clientAutomationProvenance: buildClientAutomationWorkspaceProvenance(automation, run)
          }
        )
      : null
  const worktree = createResult
    ? createResult.worktree
    : automation.workspaceId
      ? automationWorktree
      : null

  if (!worktree) {
    await markDispatchResult({
      runId: run.id,
      status: 'skipped_unavailable',
      workspaceId: automation.workspaceId,
      workspaceDisplayName: context.workspaceDisplayName,
      error: translate(
        'auto.hooks.useAutomationDispatchEvents.59718b120b',
        'The target workspace is no longer available.'
      )
    })
    return null
  }
  context.workspaceId = worktree.id
  context.workspaceDisplayName = worktree.displayName
  return worktree
}

function buildAutomationWorkspaceName(runTitle: string, scheduledFor: number): string {
  const slug = runTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  const stamp = new Date(scheduledFor).toISOString().replace(/[-:]/g, '').slice(0, 13)
  return `auto-${slug || 'run'}-${stamp}`
}

export async function connectAutomationDispatchWorkspace(args: {
  run: AutomationRun
  context: AutomationDispatchWorkspaceContext
  markDispatchResult: MarkDispatchResult
}): Promise<boolean> {
  const { run, context, markDispatchResult } = args
  const sshTargetId = context.sshTargetId
  if (sshTargetId) {
    const needsPrompt = await window.api.ssh.needsPassphrasePrompt({
      targetId: sshTargetId
    })
    if (needsPrompt) {
      await markDispatchResult({
        runId: run.id,
        status: 'skipped_needs_interactive_auth',
        workspaceId: context.workspaceId,
        workspaceDisplayName: context.workspaceDisplayName,
        error: translate(
          'auto.hooks.useAutomationDispatchEvents.16a21d6413',
          'SSH reconnect requires interactive credentials.'
        )
      })
      return false
    }
    const sshState = await window.api.ssh.getState({ targetId: sshTargetId })
    if (sshState?.status !== 'connected') {
      try {
        const connected = await window.api.ssh.connect({ targetId: sshTargetId, automatic: true })
        if (connected?.status !== 'connected') {
          throw new Error('SSH target is unavailable.')
        }
      } catch (error) {
        await markDispatchResult({
          runId: run.id,
          status: 'skipped_unavailable',
          workspaceId: context.workspaceId,
          workspaceDisplayName: context.workspaceDisplayName,
          error: error instanceof Error ? error.message : String(error)
        })
        return false
      }
    }
  }

  return true
}
