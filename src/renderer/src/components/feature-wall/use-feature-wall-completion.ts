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

// Workflows the user can mark complete just by viewing them. The rest (tasks,
// agents-orchestration, workbench, review) wait on a real signal — connection,
// setup completion, or visiting every sub-step.
const VIEW_TO_COMPLETE_WORKFLOWS = new Set<FeatureWallWorkflowId>(['workspaces'])

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
  const tasksDone = !input.isCheckingTaskSources && input.hasConnectedTaskSource
  const usageDone = input.hasUsageAccount
  const orchestrationDone =
    input.visitedAgentSteps.has('orchestration') && input.orchestrationSkillInstalled
  const notificationsDone = input.notificationsConfigured
  // Why: the keep-awake setting surfaced on Visibility is optional; viewing
  // the step should complete the tour item even when the setting stays off.
  const statusesDone = input.visitedAgentSteps.has('statuses')

  const agentsWorkflowDone = usageDone && orchestrationDone && notificationsDone && statusesDone
  // Workbench is "done" once the user has viewed every sub-step — same shape
  // as agents but each step is purely informational (no setup gate).
  const workbenchTerminalDone = input.visitedWorkbenchSteps.has('terminal')
  const workbenchEditorDone = input.visitedWorkbenchSteps.has('editor')
  const workbenchBrowserDone = input.visitedWorkbenchSteps.has('browser')
  const workbenchAllStepsDone = workbenchTerminalDone && workbenchEditorDone && workbenchBrowserDone
  // Review mixes informational and setup-backed steps: notes complete on
  // view, while PR checks and AI commit/PR reflect their live configuration.
  const reviewNotesDone = input.visitedReviewSteps.has('notes')
  const reviewPrViewDone = input.githubConfigured
  const reviewShipDone = input.aiCommitPrConfigured
  const reviewAllStepsDone = reviewNotesDone && reviewPrViewDone && reviewShipDone

  return {
    workflowDone: {
      workspaces: input.visitedWorkflows.has('workspaces'),
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
  const [visitedWorkflows, setVisitedWorkflows] = useState<Set<FeatureWallWorkflowId>>(new Set())
  const [visitedAgentSteps, setVisitedAgentSteps] = useState<Set<AgentsStepId>>(new Set())
  const [visitedWorkbenchSteps, setVisitedWorkbenchSteps] = useState<Set<WorkbenchStepId>>(
    new Set()
  )
  const [visitedReviewSteps, setVisitedReviewSteps] = useState<Set<ReviewStepId>>(new Set())

  // Reset visited workflows when the modal closes so reopening gets a fresh
  // run of "viewed this in this session" checkmarks.
  useEffect(() => {
    if (!isOpen) {
      setVisitedWorkflows(new Set())
      setVisitedAgentSteps(new Set())
      setVisitedWorkbenchSteps(new Set())
      setVisitedReviewSteps(new Set())
    }
  }, [isOpen])

  // Pull current account state once when the modal opens, then refresh on
  // window focus — keeps the checkmark current after a sign-in flow that
  // happens outside the modal.
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
      setHasUsageAccount(claudeCount + codexCount > 0)
    }
    void refresh()
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      stale = true
      window.removeEventListener('focus', onFocus)
    }
  }, [isOpen])

  const markWorkflowVisited = (id: FeatureWallWorkflowId): void => {
    if (!VIEW_TO_COMPLETE_WORKFLOWS.has(id)) {
      return
    }
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
    if (id !== 'statuses' && id !== 'orchestration') {
      return
    }
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
