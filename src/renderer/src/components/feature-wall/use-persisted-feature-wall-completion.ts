import { useCallback, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { AgentsStepId } from '../../../../shared/agents-orchestration-steps'
import type { FeatureWallWorkflowId } from '../../../../shared/feature-wall-workflows'
import type { ReviewStepId } from '../../../../shared/review-steps'
import type { WorkbenchStepId } from '../../../../shared/workbench-steps'
import {
  persistCompletedAgentStep,
  persistCompletedReviewStep,
  persistCompletedWorkbenchStep,
  persistCompletedWorkflow,
  persistVisitedAgentStep,
  persistVisitedReviewStep,
  persistVisitedWorkbenchStep,
  persistVisitedWorkflow,
  readPersistedCompletedAgentSteps,
  readPersistedCompletedReviewSteps,
  readPersistedCompletedWorkbenchSteps,
  readPersistedCompletedWorkflows,
  readPersistedVisitedAgentSteps,
  readPersistedVisitedReviewSteps,
  readPersistedVisitedWorkbenchSteps,
  readPersistedVisitedWorkflows
} from './feature-wall-completion-persistence'

export type PersistedFeatureWallCompletionState = {
  visitedWorkflows: Set<FeatureWallWorkflowId>
  visitedAgentSteps: Set<AgentsStepId>
  visitedWorkbenchSteps: Set<WorkbenchStepId>
  visitedReviewSteps: Set<ReviewStepId>
  completedWorkflows: Set<FeatureWallWorkflowId>
  completedAgentSteps: Set<AgentsStepId>
  completedWorkbenchSteps: Set<WorkbenchStepId>
  completedReviewSteps: Set<ReviewStepId>
  markWorkflowVisited: (id: FeatureWallWorkflowId) => void
  markAgentStepVisited: (id: AgentsStepId) => void
  markWorkbenchStepVisited: (id: WorkbenchStepId) => void
  markReviewStepVisited: (id: ReviewStepId) => void
  markWorkflowCompleted: (id: FeatureWallWorkflowId) => void
  markAgentStepCompleted: (id: AgentsStepId) => void
  markWorkbenchStepCompleted: (id: WorkbenchStepId) => void
  markReviewStepCompleted: (id: ReviewStepId) => void
}

function addToSet<T>(setValue: Dispatch<SetStateAction<Set<T>>>, id: T): void {
  setValue((prev) => {
    if (prev.has(id)) {
      return prev
    }
    const next = new Set(prev)
    next.add(id)
    return next
  })
}

export function usePersistedFeatureWallCompletion(): PersistedFeatureWallCompletionState {
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
  const [completedWorkflows, setCompletedWorkflows] = useState<Set<FeatureWallWorkflowId>>(() =>
    readPersistedCompletedWorkflows()
  )
  const [completedAgentSteps, setCompletedAgentSteps] = useState<Set<AgentsStepId>>(() =>
    readPersistedCompletedAgentSteps()
  )
  const [completedWorkbenchSteps, setCompletedWorkbenchSteps] = useState<Set<WorkbenchStepId>>(() =>
    readPersistedCompletedWorkbenchSteps()
  )
  const [completedReviewSteps, setCompletedReviewSteps] = useState<Set<ReviewStepId>>(() =>
    readPersistedCompletedReviewSteps()
  )

  const markWorkflowVisited = useCallback((id: FeatureWallWorkflowId): void => {
    persistVisitedWorkflow(id)
    addToSet(setVisitedWorkflows, id)
  }, [])
  const markAgentStepVisited = useCallback((id: AgentsStepId): void => {
    persistVisitedAgentStep(id)
    addToSet(setVisitedAgentSteps, id)
  }, [])
  const markWorkbenchStepVisited = useCallback((id: WorkbenchStepId): void => {
    persistVisitedWorkbenchStep(id)
    addToSet(setVisitedWorkbenchSteps, id)
  }, [])
  const markReviewStepVisited = useCallback((id: ReviewStepId): void => {
    persistVisitedReviewStep(id)
    addToSet(setVisitedReviewSteps, id)
  }, [])
  const markWorkflowCompleted = useCallback((id: FeatureWallWorkflowId): void => {
    persistCompletedWorkflow(id)
    addToSet(setCompletedWorkflows, id)
  }, [])
  const markAgentStepCompleted = useCallback((id: AgentsStepId): void => {
    persistCompletedAgentStep(id)
    addToSet(setCompletedAgentSteps, id)
  }, [])
  const markWorkbenchStepCompleted = useCallback((id: WorkbenchStepId): void => {
    persistCompletedWorkbenchStep(id)
    addToSet(setCompletedWorkbenchSteps, id)
  }, [])
  const markReviewStepCompleted = useCallback((id: ReviewStepId): void => {
    persistCompletedReviewStep(id)
    addToSet(setCompletedReviewSteps, id)
  }, [])

  return {
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
  }
}
