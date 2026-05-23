import { useEffect, useState } from 'react'
import type { FeatureWallWorkflowId } from '../../../../shared/feature-wall-workflows'
import type { AgentsStepId } from '../../../../shared/agents-orchestration-steps'
import type { WorkbenchStepId } from '../../../../shared/workbench-steps'
import type { ReviewStepId } from '../../../../shared/review-steps'
import {
  getCommitMessageAgentCapability,
  isCustomAgentId,
  resolveCommitMessageAgentChoice
} from '../../../../shared/commit-message-agent-spec'
import { useAppStore } from '@/store'
import {
  persistVisitedWorkflow,
  persistVisitedAgentStep,
  persistVisitedReviewStep,
  persistVisitedWorkbenchStep,
  readPersistedVisitedWorkflows,
  readPersistedVisitedAgentSteps,
  readPersistedVisitedReviewSteps,
  readPersistedVisitedWorkbenchSteps
} from './feature-wall-completion-persistence'
import { hasFeatureWallUsageTracking } from './feature-wall-usage-tracking'

export type FeatureWallCompletionState = {
  workflowDone: Record<FeatureWallWorkflowId, boolean>
  agentStepDone: Record<AgentsStepId, boolean>
  workbenchStepDone: Record<WorkbenchStepId, boolean>
  reviewStepDone: Record<ReviewStepId, boolean>
  markWorkflowVisited: (id: FeatureWallWorkflowId) => void
  markAgentStepVisited: (id: AgentsStepId) => void
  markWorkbenchStepVisited: (id: WorkbenchStepId) => void
  markReviewStepVisited: (id: ReviewStepId) => void
}

export type FeatureWallCompletionProgress = Pick<
  FeatureWallCompletionState,
  'workflowDone' | 'agentStepDone' | 'workbenchStepDone' | 'reviewStepDone'
>

export function getFeatureWallCompletionProgress(input: {
  visitedWorkflows: ReadonlySet<FeatureWallWorkflowId>
  visitedAgentSteps: ReadonlySet<AgentsStepId>
  visitedWorkbenchSteps: ReadonlySet<WorkbenchStepId>
  visitedReviewSteps: ReadonlySet<ReviewStepId>
  hasConnectedTaskSource: boolean
  isCheckingTaskSources: boolean
  hasUsageAccount: boolean
  orchestrationSkillInstalled: boolean
  notificationsConfigured: boolean
  githubConfigured: boolean
  aiCommitPrConfigured: boolean
}): FeatureWallCompletionProgress {
  const workspacesVisited = input.visitedWorkflows.has('workspaces')
  const tasksVisited = input.visitedWorkflows.has('tasks')
  const agentsVisited = input.visitedWorkflows.has('agents-orchestration')
  const workbenchVisited = input.visitedWorkflows.has('workbench')
  const reviewVisited = input.visitedWorkflows.has('review')

  const tasksDone = tasksVisited && !input.isCheckingTaskSources && input.hasConnectedTaskSource
  const usageDone = input.visitedAgentSteps.has('usage') && input.hasUsageAccount
  const orchestrationDone =
    input.visitedAgentSteps.has('orchestration') && input.orchestrationSkillInstalled
  const notificationsDone =
    input.visitedAgentSteps.has('notifications') && input.notificationsConfigured
  // Why: the keep-awake setting surfaced on Visibility is optional; viewing
  // the step should complete the tour item even when the setting stays off.
  const statusesDone = input.visitedAgentSteps.has('statuses')

  const agentsWorkflowDone =
    agentsVisited && usageDone && orchestrationDone && notificationsDone && statusesDone
  // Workbench is "done" once the user has viewed every sub-step — same shape
  // as agents but each step is purely informational (no setup gate).
  const workbenchTerminalDone = input.visitedWorkbenchSteps.has('terminal')
  const workbenchEditorDone = input.visitedWorkbenchSteps.has('editor')
  const workbenchBrowserDone = input.visitedWorkbenchSteps.has('browser')
  const workbenchAllStepsDone =
    workbenchVisited && workbenchTerminalDone && workbenchEditorDone && workbenchBrowserDone
  // Review mixes informational and setup-backed steps, but every checked state
  // still requires an explicit visit so existing config does not pre-check it.
  const reviewNotesDone = input.visitedReviewSteps.has('notes')
  const reviewPrViewDone = input.visitedReviewSteps.has('pr-view') && input.githubConfigured
  const reviewShipDone = input.visitedReviewSteps.has('ship') && input.aiCommitPrConfigured
  const reviewAllStepsDone = reviewVisited && reviewNotesDone && reviewPrViewDone && reviewShipDone

  return {
    workflowDone: {
      workspaces: workspacesVisited,
      tasks: tasksDone,
      'agents-orchestration': agentsWorkflowDone,
      workbench: workbenchAllStepsDone,
      review: reviewAllStepsDone
    },
    agentStepDone: {
      statuses: statusesDone,
      usage: usageDone,
      orchestration: orchestrationDone,
      notifications: notificationsDone
    },
    workbenchStepDone: {
      terminal: workbenchTerminalDone,
      editor: workbenchEditorDone,
      browser: workbenchBrowserDone
    },
    reviewStepDone: {
      notes: reviewNotesDone,
      'pr-view': reviewPrViewDone,
      ship: reviewShipDone
    }
  }
}

export function useFeatureWallCompletion(
  isOpen: boolean,
  hasConnectedTaskSource: boolean,
  isCheckingTaskSources: boolean,
  orchestrationSkillInstalled: boolean
): FeatureWallCompletionState {
  const settings = useAppStore((s) => s.settings)
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const rateLimits = useAppStore((s) => s.rateLimits)
  const fetchRateLimits = useAppStore((s) => s.fetchRateLimits)
  const notificationsConfigured =
    settings?.notifications.enabled === true && settings?.notifications.agentTaskComplete === true
  const githubConfigured =
    preflightStatus?.gh.installed === true && preflightStatus.gh.authenticated === true
  const commitMessageAi = settings?.commitMessageAi
  const resolvedCommitMessageAgent =
    settings && commitMessageAi?.enabled === true
      ? resolveCommitMessageAgentChoice(commitMessageAi.agentId, settings.defaultTuiAgent)
      : null
  const aiCommitPrConfigured =
    commitMessageAi?.enabled === true &&
    (isCustomAgentId(resolvedCommitMessageAgent)
      ? (commitMessageAi.customAgentCommand ?? '').trim().length > 0
      : resolvedCommitMessageAgent
        ? getCommitMessageAgentCapability(resolvedCommitMessageAgent) !== undefined
        : false)

  const [hasUsageAccount, setHasUsageAccount] = useState(false)
  const [visitedWorkflows, setVisitedWorkflows] = useState<Set<FeatureWallWorkflowId>>(() =>
    readPersistedVisitedWorkflows()
  )
  const [visitedAgentSteps, setVisitedAgentSteps] = useState<Set<AgentsStepId>>(() =>
    readPersistedVisitedAgentSteps()
  )
  const [visitedWorkbenchSteps, setVisitedWorkbenchSteps] = useState<Set<WorkbenchStepId>>(() =>
    readPersistedVisitedWorkbenchSteps()
  )
  const [visitedReviewSteps, setVisitedReviewSteps] = useState<Set<ReviewStepId>>(() =>
    readPersistedVisitedReviewSteps()
  )

  // Reset from persisted state on close so another window or tab's tour visit
  // is reflected the next time this modal opens.
  useEffect(() => {
    if (!isOpen) {
      setVisitedWorkflows(readPersistedVisitedWorkflows())
      setVisitedAgentSteps(readPersistedVisitedAgentSteps())
      setVisitedWorkbenchSteps(readPersistedVisitedWorkbenchSteps())
      setVisitedReviewSteps(readPersistedVisitedReviewSteps())
    }
  }, [isOpen])

  // Pull current account state once when the modal opens, then refresh on
  // window focus — keeps the checkmark current after a sign-in flow that
  // happens outside the modal.
  useEffect(() => {
    if (isOpen) {
      void fetchRateLimits()
    }
  }, [fetchRateLimits, isOpen])

  useEffect(() => {
    if (!isOpen) {
      return
    }
    let stale = false
    const refresh = async (): Promise<void> => {
      const [claude, codex] = await Promise.all([
        window.api.claudeAccounts.list().catch(() => null),
        window.api.codexAccounts.list().catch(() => null)
      ])
      if (stale) {
        return
      }
      const claudeCount = claude?.accounts.length ?? 0
      const codexCount = codex?.accounts.length ?? 0
      setHasUsageAccount(
        hasFeatureWallUsageTracking({
          claudeManagedAccountCount: claudeCount,
          codexManagedAccountCount: codexCount,
          claudeRateLimits: rateLimits.claude,
          codexRateLimits: rateLimits.codex
        })
      )
    }
    void refresh()
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      stale = true
      window.removeEventListener('focus', onFocus)
    }
  }, [isOpen, rateLimits.claude, rateLimits.codex])

  const markWorkflowVisited = (id: FeatureWallWorkflowId): void => {
    persistVisitedWorkflow(id)
    setVisitedWorkflows((prev) => {
      if (prev.has(id)) {
        return prev
      }
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }
  const markAgentStepVisited = (id: AgentsStepId): void => {
    persistVisitedAgentStep(id)
    setVisitedAgentSteps((prev) => {
      if (prev.has(id)) {
        return prev
      }
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }
  const markWorkbenchStepVisited = (id: WorkbenchStepId): void => {
    persistVisitedWorkbenchStep(id)
    setVisitedWorkbenchSteps((prev) => {
      if (prev.has(id)) {
        return prev
      }
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }
  const markReviewStepVisited = (id: ReviewStepId): void => {
    persistVisitedReviewStep(id)
    setVisitedReviewSteps((prev) => {
      if (prev.has(id)) {
        return prev
      }
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }

  const { workflowDone, agentStepDone, workbenchStepDone, reviewStepDone } =
    getFeatureWallCompletionProgress({
      visitedWorkflows,
      visitedAgentSteps,
      visitedWorkbenchSteps,
      visitedReviewSteps,
      hasConnectedTaskSource,
      isCheckingTaskSources,
      hasUsageAccount,
      orchestrationSkillInstalled,
      notificationsConfigured,
      githubConfigured,
      aiCommitPrConfigured
    })

  return {
    workflowDone,
    agentStepDone,
    workbenchStepDone,
    reviewStepDone,
    markWorkflowVisited,
    markAgentStepVisited,
    markWorkbenchStepVisited,
    markReviewStepVisited
  }
}
