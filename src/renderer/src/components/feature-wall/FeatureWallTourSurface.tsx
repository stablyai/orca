import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import {
  DEFAULT_FEATURE_WALL_WORKFLOW_ID,
  FEATURE_WALL_WORKFLOWS,
  getFeatureWallMediaTile,
  type FeatureWallWorkflow,
  type FeatureWallWorkflowId
} from '../../../../shared/feature-wall-workflows'
import { getAgentsSteps, type AgentsStepId } from '../../../../shared/agents-orchestration-steps'
import { getWorkbenchSteps, type WorkbenchStepId } from '../../../../shared/workbench-steps'
import { getReviewSteps, type ReviewStepId } from '../../../../shared/review-steps'
import type { FeatureWallOpenSourceTelemetry } from '../../../../shared/telemetry-events'
import type { FeatureWallTourDepthSummary } from '../../../../shared/feature-wall-tour-depth'
import { track } from '@/lib/telemetry'
import { useAppStore } from '@/store'
import { ORCA_CLI_SKILL_NAME, ORCHESTRATION_SKILL_NAME } from '@/lib/agent-feature-install-commands'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import { usePrefersReducedMotion } from './feature-wall-modal-helpers'
import { toFeatureWallAssetUrl, useFeatureWallAssetBaseUrl } from './feature-wall-assets'
import { useFeatureWallTaskSourcePresentation } from './use-feature-wall-task-source-presentation'
import { useFeatureWallCompletion } from './use-feature-wall-completion'
import { useFeatureWallTourTelemetry } from './use-feature-wall-tour-telemetry'
import { FeatureWallContinueButton } from './FeatureWallContinueButton'
import { FeatureWallTourPanel } from './FeatureWallTourPanel'
import { getFeatureWallActiveStepCopy } from './feature-wall-active-step-copy'
import { getScreenSubmitModifierLabel } from '@/lib/screen-submit-shortcut'
import { useFeatureWallTourKeyboardShortcut } from './use-feature-wall-tour-keyboard-shortcut'
import { useFeatureWallTourRailKeydown } from './use-feature-wall-tour-rail-keydown'

type FeatureWallTourSurfaceProps = {
  isOpen: boolean
  source: FeatureWallOpenSourceTelemetry
  onDone: (markSuccessfulExit?: () => void) => boolean | void | Promise<boolean | void>
  className?: string
  panelClassName?: string
  doneLabel?: string
  footerText?: string | null
  enableKeyboardShortcut?: boolean
  compactRail?: boolean
  detachedFooter?: boolean
  leadingFooterContent?: ReactNode
  onTourDepthSummaryChange?: (summary: FeatureWallTourDepthSummary) => void
}

export function FeatureWallTourSurface({
  isOpen,
  source,
  onDone,
  className,
  panelClassName,
  doneLabel = 'Done',
  footerText = 'Reopen any time from Help > Explore Orca.',
  enableKeyboardShortcut = true,
  compactRail = false,
  detachedFooter = false,
  leadingFooterContent,
  onTourDepthSummaryChange
}: FeatureWallTourSurfaceProps): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const assetBaseUrl = useFeatureWallAssetBaseUrl(isOpen)
  const prefersReducedMotion = usePrefersReducedMotion()
  const reactId = useId()
  const previewPanelId = `${reactId}-feature-wall-preview-panel`
  const [selectedId, setSelectedId] = useState<FeatureWallWorkflowId>(
    DEFAULT_FEATURE_WALL_WORKFLOW_ID
  )
  const railRefs = useRef<(HTMLButtonElement | null)[]>([])

  const selectedIndex = useMemo(
    () =>
      Math.max(
        0,
        FEATURE_WALL_WORKFLOWS.findIndex((w) => w.id === selectedId)
      ),
    [selectedId]
  )
  const selected = FEATURE_WALL_WORKFLOWS[selectedIndex]
  const taskSourcePresentation = useFeatureWallTaskSourcePresentation(isOpen, selected)
  const selectedPresentation = taskSourcePresentation.workflow
  const agentsSteps = useMemo(() => getAgentsSteps(), [])
  const workbenchSteps = useMemo(() => getWorkbenchSteps(), [])
  const reviewSteps = useMemo(() => getReviewSteps(), [])
  const [agentsStepId, setAgentsStepId] = useState<AgentsStepId>(
    () => agentsSteps[0]?.id ?? 'statuses'
  )
  const [workbenchStepId, setWorkbenchStepId] = useState<WorkbenchStepId>(
    () => workbenchSteps[0]?.id ?? 'terminal'
  )
  const [reviewStepId, setReviewStepId] = useState<ReviewStepId>(
    () => reviewSteps[0]?.id ?? 'notes'
  )
  const [previousOpen, setPreviousOpen] = useState(isOpen)
  if (isOpen !== previousOpen) {
    setPreviousOpen(isOpen)
    if (!isOpen) {
      setSelectedId(DEFAULT_FEATURE_WALL_WORKFLOW_ID)
      setAgentsStepId(agentsSteps[0]?.id ?? 'statuses')
      setWorkbenchStepId(workbenchSteps[0]?.id ?? 'terminal')
      setReviewStepId(reviewSteps[0]?.id ?? 'notes')
    }
  }
  // Why: the feature-wall completion model owns skill-completion state, so read
  // installed skills here instead of asking child setup cards to notify upward
  // from passive Effects.
  const orchestrationSkill = useInstalledAgentSkill(ORCHESTRATION_SKILL_NAME, {
    enabled: isOpen,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  const browserUseSkill = useInstalledAgentSkill(ORCA_CLI_SKILL_NAME, {
    enabled: isOpen,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  const completion = useFeatureWallCompletion(
    isOpen,
    taskSourcePresentation.hasConnectedTaskSource,
    taskSourcePresentation.isCheckingTaskSources,
    orchestrationSkill.installed,
    browserUseSkill.installed,
    { onTourDepthSummaryChange }
  )
  const { markExitAction } = useFeatureWallTourTelemetry({
    isOpen,
    source,
    getDepthSummary: completion.getTourDepthSummary
  })
  const {
    markWorkflowVisited,
    markAgentStepVisited,
    markWorkbenchStepVisited,
    markReviewStepVisited
  } = completion
  const markWorkflowVisitedRef = useRef(markWorkflowVisited)
  markWorkflowVisitedRef.current = markWorkflowVisited

  const agentsActiveStep =
    selected.id === 'agents-orchestration'
      ? (agentsSteps.find((s) => s.id === agentsStepId) ?? agentsSteps[0] ?? null)
      : null
  const workbenchActiveStep =
    selected.id === 'workbench'
      ? (workbenchSteps.find((s) => s.id === workbenchStepId) ?? workbenchSteps[0] ?? null)
      : null
  const reviewActiveStep =
    selected.id === 'review'
      ? (reviewSteps.find((s) => s.id === reviewStepId) ?? reviewSteps[0] ?? null)
      : null
  const primaryTile = getFeatureWallMediaTile(selected.primaryTileId)
  const posterUrl = primaryTile ? toFeatureWallAssetUrl(assetBaseUrl, primaryTile.posterPath) : null
  const gifUrl = primaryTile ? toFeatureWallAssetUrl(assetBaseUrl, primaryTile.gifPath) : null
  const activeStepCopy = getFeatureWallActiveStepCopy(
    agentsActiveStep,
    workbenchActiveStep,
    reviewActiveStep
  )

  useEffect(() => {
    if (isOpen) {
      markWorkflowVisitedRef.current(DEFAULT_FEATURE_WALL_WORKFLOW_ID)
      track('feature_wall_group_selected', {
        group_id: DEFAULT_FEATURE_WALL_WORKFLOW_ID,
        source
      })
      const defaultTile = getFeatureWallMediaTile(FEATURE_WALL_WORKFLOWS[0].primaryTileId)
      if (defaultTile) {
        track('feature_wall_feature_selected', {
          group_id: DEFAULT_FEATURE_WALL_WORKFLOW_ID,
          tile_id: defaultTile.id,
          source
        })
        // Keep the legacy hover/focus event firing too for analytics
        // continuity until dashboards are migrated to feature_selected.
        track('feature_wall_tile_focused', { tile_id: defaultTile.id })
      }
    }
  }, [isOpen, source])

  const handleSelect = useCallback(
    (workflow: FeatureWallWorkflow): void => {
      markWorkflowVisited(workflow.id)
      if (workflow.id === selectedId) {
        return
      }
      setSelectedId(workflow.id)
      if (workflow.id === 'agents-orchestration') {
        const nextStepId = agentsSteps[0]?.id ?? 'statuses'
        markAgentStepVisited(nextStepId)
        setAgentsStepId(nextStepId)
      } else if (workflow.id === 'workbench') {
        const nextStepId = workbenchSteps[0]?.id ?? 'terminal'
        markWorkbenchStepVisited(nextStepId)
        setWorkbenchStepId(nextStepId)
      } else if (workflow.id === 'review') {
        const nextStepId = reviewSteps[0]?.id ?? 'notes'
        markReviewStepVisited(nextStepId)
        setReviewStepId(nextStepId)
      }
      track('feature_wall_group_selected', { group_id: workflow.id, source })
      const tile = getFeatureWallMediaTile(workflow.primaryTileId)
      if (tile) {
        track('feature_wall_feature_selected', {
          group_id: workflow.id,
          tile_id: tile.id,
          source
        })
        track('feature_wall_tile_focused', { tile_id: tile.id })
      }
    },
    [
      agentsSteps,
      markAgentStepVisited,
      markReviewStepVisited,
      markWorkbenchStepVisited,
      markWorkflowVisited,
      reviewSteps,
      selectedId,
      source,
      workbenchSteps
    ]
  )

  const handleSelectAgentsStep = useCallback(
    (id: AgentsStepId): void => {
      markAgentStepVisited(id)
      setAgentsStepId(id)
    },
    [markAgentStepVisited]
  )

  const handleSelectWorkbenchStep = useCallback(
    (id: WorkbenchStepId): void => {
      markWorkbenchStepVisited(id)
      setWorkbenchStepId(id)
    },
    [markWorkbenchStepVisited]
  )

  const handleSelectReviewStep = useCallback(
    (id: ReviewStepId): void => {
      markReviewStepVisited(id)
      setReviewStepId(id)
    },
    [markReviewStepVisited]
  )

  const handleRailKeyDown = useFeatureWallTourRailKeydown({
    railRefs,
    onSelectWorkflow: handleSelect
  })

  const isLastWorkflow = selectedIndex >= FEATURE_WALL_WORKFLOWS.length - 1
  const agentsStepIndex =
    selected.id === 'agents-orchestration'
      ? agentsSteps.findIndex((step) => step.id === agentsStepId)
      : -1
  const workbenchStepIndex =
    selected.id === 'workbench'
      ? workbenchSteps.findIndex((step) => step.id === workbenchStepId)
      : -1
  const reviewStepIndex =
    selected.id === 'review' ? reviewSteps.findIndex((step) => step.id === reviewStepId) : -1
  const hasNextSubStep =
    (selected.id === 'agents-orchestration' &&
      (agentsStepIndex < 0 ? agentsSteps.length > 0 : agentsStepIndex < agentsSteps.length - 1)) ||
    (selected.id === 'workbench' &&
      (workbenchStepIndex < 0
        ? workbenchSteps.length > 0
        : workbenchStepIndex < workbenchSteps.length - 1)) ||
    (selected.id === 'review' &&
      (reviewStepIndex < 0 ? reviewSteps.length > 0 : reviewStepIndex < reviewSteps.length - 1))
  const continueLabel = isLastWorkflow && !hasNextSubStep ? doneLabel : 'Continue'
  const handleContinue = useCallback((): void => {
    markWorkflowVisited(selected.id)
    if (selected.id === 'agents-orchestration') {
      markAgentStepVisited(agentsStepId)
      const nextStep = agentsSteps[agentsStepIndex >= 0 ? agentsStepIndex + 1 : 0]
      if (nextStep) {
        markAgentStepVisited(nextStep.id)
        setAgentsStepId(nextStep.id)
        return
      }
    }
    if (selected.id === 'workbench') {
      markWorkbenchStepVisited(workbenchStepId)
      const nextStep = workbenchSteps[workbenchStepIndex >= 0 ? workbenchStepIndex + 1 : 0]
      if (nextStep) {
        markWorkbenchStepVisited(nextStep.id)
        setWorkbenchStepId(nextStep.id)
        return
      }
    }
    if (selected.id === 'review') {
      markReviewStepVisited(reviewStepId)
      const nextStep = reviewSteps[reviewStepIndex >= 0 ? reviewStepIndex + 1 : 0]
      if (nextStep) {
        markReviewStepVisited(nextStep.id)
        setReviewStepId(nextStep.id)
        return
      }
    }
    if (isLastWorkflow) {
      const exitAction = source === 'onboarding' ? 'onboarding_continue' : 'done'
      let markedSuccessfulExit = false
      const markSuccessfulExit = (): void => {
        if (markedSuccessfulExit) {
          return
        }
        markedSuccessfulExit = true
        markExitAction(exitAction)
      }
      const doneResult = onDone(markSuccessfulExit)
      if (doneResult instanceof Promise) {
        void doneResult.then((result) => result !== false && markSuccessfulExit())
      } else if (doneResult !== false) {
        markSuccessfulExit()
      }
      return
    }
    const nextWorkflow = FEATURE_WALL_WORKFLOWS[selectedIndex + 1]
    if (nextWorkflow) {
      handleSelect(nextWorkflow)
      railRefs.current[selectedIndex + 1]?.focus()
    }
  }, [
    agentsStepId,
    agentsStepIndex,
    agentsSteps,
    handleSelect,
    isLastWorkflow,
    markAgentStepVisited,
    markExitAction,
    markReviewStepVisited,
    markWorkbenchStepVisited,
    markWorkflowVisited,
    onDone,
    reviewStepId,
    reviewStepIndex,
    reviewSteps,
    selected.id,
    selectedIndex,
    source,
    workbenchStepId,
    workbenchStepIndex,
    workbenchSteps
  ])

  useFeatureWallTourKeyboardShortcut({
    isOpen,
    enabled: enableKeyboardShortcut,
    onContinue: handleContinue
  })

  if (!isOpen) {
    return null
  }

  const showGif = !prefersReducedMotion && gifUrl !== null
  const previewTitleId = `${reactId}-feature-wall-preview-${selected.id}`
  const description = activeStepCopy?.description ?? selectedPresentation.lede
  const continueButton = (
    <FeatureWallContinueButton
      label={continueLabel}
      enableKeyboardShortcut={enableKeyboardShortcut}
      shortcutModifierLabel={getScreenSubmitModifierLabel()}
      onClick={handleContinue}
    />
  )

  return (
    <FeatureWallTourPanel
      className={className}
      panelClassName={panelClassName}
      detachedFooter={detachedFooter}
      compactRail={compactRail}
      previewPanelId={previewPanelId}
      previewTitleId={previewTitleId}
      selected={selected}
      description={description}
      activeStepCopy={activeStepCopy}
      completion={completion}
      railRefs={railRefs}
      onSelectWorkflow={handleSelect}
      onRailKeyDown={handleRailKeyDown}
      agentsSteps={agentsSteps}
      agentsActiveStep={agentsActiveStep}
      onSelectAgentsStep={handleSelectAgentsStep}
      workbenchSteps={workbenchSteps}
      workbenchActiveStep={workbenchActiveStep}
      onSelectWorkbenchStep={handleSelectWorkbenchStep}
      reviewSteps={reviewSteps}
      reviewActiveStep={reviewActiveStep}
      onSelectReviewStep={handleSelectReviewStep}
      posterUrl={posterUrl}
      gifUrl={gifUrl}
      showGif={showGif}
      prefersReducedMotion={prefersReducedMotion}
      source={source}
      orchestrationSkill={orchestrationSkill}
      browserUseSkill={browserUseSkill}
      settings={settings}
      updateSettings={updateSettings}
      footerText={footerText}
      continueButton={continueButton}
      leadingFooterContent={leadingFooterContent}
    />
  )
}
