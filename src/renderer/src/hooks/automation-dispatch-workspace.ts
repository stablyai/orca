import { launchWorktreeBackgroundTerminals } from '@/lib/launch-worktree-background-terminals'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
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
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../../shared/execution-host'
import { resolveFolderWorkspaceHost } from '../../../shared/folder-workspace-execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'

type AutomationDispatchStoreState = ReturnType<typeof useAppStore.getState>
type MarkDispatchResult = (result: AutomationDispatchResult) => Promise<void>

export type AutomationDispatchWorkspaceContext = {
  workspaceId: string | null
  workspaceDisplayName: string | null
  precheckResult: AutomationPrecheckResult | null
}

export function resolveAutomationDispatchWorkspace(
  state: AutomationDispatchStoreState,
  automation: Automation,
  run: AutomationRun
) {
  const runRepoId = getAutomationRunRepoId(automation)
  const repo = state.repos.find((entry) => entry.id === runRepoId)
  const automationWorkspaceScope = parseWorkspaceKey(automation.workspaceId ?? '')
  const automationWorktree = automation.workspaceId
    ? automationWorkspaceScope?.type === 'folder'
      ? state.getKnownWorktreeById(automation.workspaceId)
      : state.allWorktrees().find((entry) => entry.id === automation.workspaceId)
    : null
  const context: AutomationDispatchWorkspaceContext = {
    workspaceId: automation.workspaceId,
    workspaceDisplayName: automationWorktree?.displayName ?? run.workspaceDisplayName ?? null,
    precheckResult: null
  }
  return { runRepoId, repo, automationWorkspaceScope, automationWorktree, context }
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
  const { repo, runRepoId, automationWorkspaceScope, automationWorktree, context } = resolved
  const folderWorkspaceHost =
    automationWorkspaceScope?.type === 'folder'
      ? resolveFolderWorkspaceHost(state, automationWorkspaceScope.folderWorkspaceId)
      : null
  const folderWorkspaceConnectionId =
    folderWorkspaceHost?.kind === 'ssh' ? folderWorkspaceHost.targetId : null
  // A workspace whose host does not resolve to one place is refused, not guessed at.
  const folderWorkspaceHostUnresolved =
    folderWorkspaceHost !== null && folderWorkspaceHost.kind === 'ambiguous'
  const folderWorkspaceHostId =
    folderWorkspaceHost && automationWorktree
      ? folderWorkspaceConnectionId
        ? toSshExecutionHostId(folderWorkspaceConnectionId)
        : folderWorkspaceHost.kind === 'local'
          ? getResolvedExecutionHostIdForWorktree(state, automationWorktree.id)
          : null
      : null
  const runHostId =
    parseExecutionHostId(automation.runContext?.hostId)?.id ?? getRepoExecutionHostId(repo)
  const workspaceMatchesRunTarget =
    automationWorkspaceScope?.type === 'folder'
      ? folderWorkspaceHostId !== null && folderWorkspaceHostId === runHostId
      : !automation.runContext?.repoId ||
        automationWorktree?.repoId === automation.runContext.repoId
  if (automation.workspaceMode === 'existing' && automationWorktree && !workspaceMatchesRunTarget) {
    await markDispatchResult({
      runId: run.id,
      status: 'skipped_unavailable',
      workspaceId: automation.workspaceId,
      workspaceDisplayName: context.workspaceDisplayName,
      error: folderWorkspaceHostUnresolved
        ? translate(
            'auto.hooks.useAutomationDispatchEvents.workspaceHostUnresolved',
            'The target workspace spans more than one host, so this run has no single host to use.'
          )
        : translate(
            'auto.hooks.useAutomationDispatchEvents.3ad7d77f57',
            'The target workspace is on a different host than this automation run target.'
          )
    })
    return null
  }
  const sshTargetId =
    automationWorkspaceScope?.type === 'folder'
      ? (folderWorkspaceConnectionId ?? null)
      : (repo.connectionId ?? null)
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
      return null
    }
    const sshState = await window.api.ssh.getState({ targetId: sshTargetId })
    if (sshState?.status !== 'connected') {
      try {
        const connected = await window.api.ssh.connect({ targetId: sshTargetId })
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
        return null
      }
    }
  }

  if (automation.workspaceMode === 'existing' && !automationWorktree) {
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
          // Why: the automation session below owns the prompt-bearing
          // agent tab; createdWithAgent would reopen an empty fallback.
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
            automationProvenanceRequest: {
              automationId: automation.id,
              automationRunId: run.id,
              dispatchToken,
              createRequestId: automationWorkspaceCreateRequestId
            }
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
  if (createResult?.setup || createResult?.defaultTabs) {
    void launchWorktreeBackgroundTerminals({
      worktreeId: worktree.id,
      setup: createResult.setup,
      defaultTabs: createResult.defaultTabs
    }).catch((error) => {
      // Why: setup/defaultTabs match normal worktree creation: they are
      // best-effort terminal work and must not block the automation agent.
      console.warn('[automations] Failed to launch workspace setup/default tabs:', error)
    })
  }
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
