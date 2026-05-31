import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FeatureWallWorkflowId } from '../../../../shared/feature-wall-workflows'
import type { AgentsStepId } from '../../../../shared/agents-orchestration-steps'
import type { WorkbenchStepId } from '../../../../shared/workbench-steps'
import type { ReviewStepId } from '../../../../shared/review-steps'
import type { FeatureWallTourDepthSummary } from '../../../../shared/feature-wall-tour-depth'
import {
  getCommitMessageAgentCapability,
  isCustomAgentId,
  resolveCommitMessageAgentChoice
} from '../../../../shared/commit-message-agent-spec'
import { useAppStore } from '@/store'
import {
  FEATURE_WALL_AGENT_STEP_IDS,
  FEATURE_WALL_REVIEW_STEP_IDS,
  FEATURE_WALL_WORKBENCH_STEP_IDS,
  getFeatureWallCompletionProgress
} from './feature-wall-completion-progress'
import { hasFeatureWallUsageTracking } from './feature-wall-usage-tracking'
import { usePersistedFeatureWallCompletion } from './use-persisted-feature-wall-completion'
import { useFeatureWallSessionDepth } from './use-feature-wall-session-depth'
import { useMountedRef } from '@/hooks/useMountedRef'

export type FeatureWallCompletionState = {
  workflowDone: Record<FeatureWallWorkflowId, boolean>
  agentStepDone: Record<AgentsStepId, boolean>
  workbenchStepDone: Record<WorkbenchStepId, boolean>
  reviewStepDone: Record<ReviewStepId, boolean>
  markWorkflowVisited: (id: FeatureWallWorkflowId) => void
  markAgentStepVisited: (id: AgentsStepId) => void
  markWorkbenchStepVisited: (id: WorkbenchStepId) => void
  markReviewStepVisited: (id: ReviewStepId) => void
  refreshUsageAccountState: () => Promise<void>
  getTourDepthSummary: () => FeatureWallTourDepthSummary
}

export function useFeatureWallCompletion(
  isOpen: boolean,
  hasConnectedTaskSource: boolean,
  isCheckingTaskSources: boolean,
  orchestrationSkillInstalled: boolean,
  browserUseSkillInstalled: boolean,
  options: { onTourDepthSummaryChange?: (summary: FeatureWallTourDepthSummary) => void } = {}
): FeatureWallCompletionState {
  const { onTourDepthSummaryChange } = options
  const settings = useAppStore((s) => s.settings)
  const mountedRef = useMountedRef()
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const rateLimits = useAppStore((s) => s.rateLimits)
  const fetchRateLimits = useAppStore((s) => s.fetchRateLimits)
  const githubConfigured =
    preflightStatus?.gh.installed === true && preflightStatus.gh.authenticated === true
  const commitMessageAi = settings?.commitMessageAi
  const resolvedCommitMessageAgent =
    settings && commitMessageAi?.enabled === true
      ? resolveCommitMessageAgentChoice(
          commitMessageAi.agentId,
          settings.defaultTuiAgent,
          settings.disabledTuiAgents
        )
      : null
  const aiCommitPrConfigured =
    commitMessageAi?.enabled === true &&
    (isCustomAgentId(resolvedCommitMessageAgent)
      ? (commitMessageAi.customAgentCommand ?? '').trim().length > 0
      : resolvedCommitMessageAgent
        ? getCommitMessageAgentCapability(resolvedCommitMessageAgent) !== undefined
        : false)

  const [hasUsageAccount, setHasUsageAccount] = useState(false)
  const persistedCompletion = usePersistedFeatureWallCompletion()
  const {
    visitedWorkflows,
    visitedAgentSteps,
    visitedWorkbenchSteps,
    visitedReviewSteps,
    completedWorkflows,
    completedAgentSteps,
    completedWorkbenchSteps,
    completedReviewSteps,
    markWorkflowVisited,
    markAgentStepVisited,
    markWorkbenchStepVisited,
    markReviewStepVisited,
    markWorkflowCompleted,
    markAgentStepCompleted,
    markWorkbenchStepCompleted,
    markReviewStepCompleted
  } = persistedCompletion

  const readUsageAccountState = useCallback(async (): Promise<boolean> => {
    const [claude, codex] = await Promise.all([
      window.api.claudeAccounts.list().catch(() => null),
      window.api.codexAccounts.list().catch(() => null)
    ])
    return hasFeatureWallUsageTracking({
      claudeManagedAccountCount: claude?.accounts.length ?? 0,
      codexManagedAccountCount: codex?.accounts.length ?? 0,
      claudeRateLimits: rateLimits.claude,
      codexRateLimits: rateLimits.codex
    })
  }, [rateLimits.claude, rateLimits.codex])

  const refreshUsageAccountState = useCallback(async (): Promise<void> => {
    const nextHasUsageAccount = await readUsageAccountState()
    if (mountedRef.current) {
      setHasUsageAccount(nextHasUsageAccount)
    }
  }, [mountedRef, readUsageAccountState])

  const sessionDepth = useFeatureWallSessionDepth({
    isOpen,
    hasConnectedTaskSource,
    isCheckingTaskSources,
    hasUsageAccount,
    orchestrationSkillInstalled,
    browserUseSkillInstalled,
    githubConfigured,
    aiCommitPrConfigured,
    onTourDepthSummaryChange
  })

  // Pull current account state once when the modal opens, then refresh on focus
  // after a sign-in flow that happens outside the modal.
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
      const nextHasUsageAccount = await readUsageAccountState()
      if (stale) {
        return
      }
      setHasUsageAccount(nextHasUsageAccount)
    }
    void refresh()
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      stale = true
      window.removeEventListener('focus', onFocus)
    }
  }, [isOpen, readUsageAccountState])

  const currentProgress = useMemo(
    () =>
      getFeatureWallCompletionProgress({
        visitedWorkflows,
        visitedAgentSteps,
        visitedWorkbenchSteps,
        visitedReviewSteps,
        hasConnectedTaskSource,
        isCheckingTaskSources,
        hasUsageAccount,
        orchestrationSkillInstalled,
        browserUseSkillInstalled,
        githubConfigured,
        aiCommitPrConfigured
      }),
    [
      aiCommitPrConfigured,
      browserUseSkillInstalled,
      githubConfigured,
      hasConnectedTaskSource,
      hasUsageAccount,
      isCheckingTaskSources,
      orchestrationSkillInstalled,
      visitedAgentSteps,
      visitedReviewSteps,
      visitedWorkbenchSteps,
      visitedWorkflows
    ]
  )

  // Why: tour checkmarks are progress acknowledgements; once a user sees one
  // turn green, later setup polling should not make it disappear.
  useEffect(() => {
    if (!isOpen) {
      return
    }
    for (const id of Object.keys(currentProgress.workflowDone) as FeatureWallWorkflowId[]) {
      if (currentProgress.workflowDone[id] && !completedWorkflows.has(id)) {
        markWorkflowCompleted(id)
      }
    }
    for (const id of FEATURE_WALL_AGENT_STEP_IDS) {
      if (currentProgress.agentStepDone[id] && !completedAgentSteps.has(id)) {
        markAgentStepCompleted(id)
      }
    }
    for (const id of FEATURE_WALL_WORKBENCH_STEP_IDS) {
      if (currentProgress.workbenchStepDone[id] && !completedWorkbenchSteps.has(id)) {
        markWorkbenchStepCompleted(id)
      }
    }
    for (const id of FEATURE_WALL_REVIEW_STEP_IDS) {
      if (currentProgress.reviewStepDone[id] && !completedReviewSteps.has(id)) {
        markReviewStepCompleted(id)
      }
    }
  }, [
    completedAgentSteps,
    completedReviewSteps,
    completedWorkbenchSteps,
    completedWorkflows,
    currentProgress,
    isOpen,
    markAgentStepCompleted,
    markReviewStepCompleted,
    markWorkbenchStepCompleted,
    markWorkflowCompleted
  ])

  const { workflowDone, agentStepDone, workbenchStepDone, reviewStepDone } = useMemo(
    () =>
      getFeatureWallCompletionProgress({
        visitedWorkflows,
        visitedAgentSteps,
        visitedWorkbenchSteps,
        visitedReviewSteps,
        completedWorkflows,
        completedAgentSteps,
        completedWorkbenchSteps,
        completedReviewSteps,
        hasConnectedTaskSource,
        isCheckingTaskSources,
        hasUsageAccount,
        orchestrationSkillInstalled,
        browserUseSkillInstalled,
        githubConfigured,
        aiCommitPrConfigured
      }),
    [
      aiCommitPrConfigured,
      browserUseSkillInstalled,
      completedAgentSteps,
      completedReviewSteps,
      completedWorkbenchSteps,
      completedWorkflows,
      githubConfigured,
      hasConnectedTaskSource,
      hasUsageAccount,
      isCheckingTaskSources,
      orchestrationSkillInstalled,
      visitedAgentSteps,
      visitedReviewSteps,
      visitedWorkbenchSteps,
      visitedWorkflows
    ]
  )

  const {
    markWorkflowVisitedForSession: markSessionWorkflowVisited,
    markAgentStepVisitedForSession: markSessionAgentStepVisited,
    markWorkbenchStepVisitedForSession: markSessionWorkbenchStepVisited,
    markReviewStepVisitedForSession: markSessionReviewStepVisited,
    getTourDepthSummary
  } = sessionDepth

  const markWorkflowVisitedForSession = useCallback(
    (id: FeatureWallWorkflowId): void => {
      markWorkflowVisited(id)
      markSessionWorkflowVisited(id)
    },
    [markSessionWorkflowVisited, markWorkflowVisited]
  )
  const markAgentStepVisitedForSession = useCallback(
    (id: AgentsStepId): void => {
      markAgentStepVisited(id)
      markSessionAgentStepVisited(id)
    },
    [markAgentStepVisited, markSessionAgentStepVisited]
  )
  const markWorkbenchStepVisitedForSession = useCallback(
    (id: WorkbenchStepId): void => {
      markWorkbenchStepVisited(id)
      markSessionWorkbenchStepVisited(id)
    },
    [markSessionWorkbenchStepVisited, markWorkbenchStepVisited]
  )
  const markReviewStepVisitedForSession = useCallback(
    (id: ReviewStepId): void => {
      markReviewStepVisited(id)
      markSessionReviewStepVisited(id)
    },
    [markReviewStepVisited, markSessionReviewStepVisited]
  )

  return {
    workflowDone,
    agentStepDone,
    workbenchStepDone,
    reviewStepDone,
    markWorkflowVisited: markWorkflowVisitedForSession,
    markAgentStepVisited: markAgentStepVisitedForSession,
    markWorkbenchStepVisited: markWorkbenchStepVisitedForSession,
    markReviewStepVisited: markReviewStepVisitedForSession,
    refreshUsageAccountState,
    getTourDepthSummary
  }
}
