import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getFeatureWallOpenSource, usePrefersReducedMotion } from './feature-wall-modal-helpers'
import type { JSX, KeyboardEvent } from 'react'
import { CornerDownLeft } from 'lucide-react'
import {
  DEFAULT_FEATURE_WALL_WORKFLOW_ID,
  FEATURE_WALL_WORKFLOWS,
  getFeatureWallMediaTile,
  type FeatureWallWorkflow,
  type FeatureWallWorkflowId
} from '../../../../shared/feature-wall-workflows'
import { FEATURE_WALL_MAX_DWELL_MS } from '../../../../shared/feature-wall-telemetry'
import { getAgentsSteps, type AgentsStepId } from '../../../../shared/agents-orchestration-steps'
import { getWorkbenchSteps, type WorkbenchStepId } from '../../../../shared/workbench-steps'
import { getReviewSteps, type ReviewStepId } from '../../../../shared/review-steps'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { track } from '@/lib/telemetry'
import { useAppStore } from '@/store'
import {
  getFeatureWallRailNavigationTarget,
  type FeatureWallRailNavigationKey
} from './feature-wall-rail-navigation'
import { toFeatureWallAssetUrl, useFeatureWallAssetBaseUrl } from './feature-wall-assets'
import { useFeatureWallTaskSourcePresentation } from './use-feature-wall-task-source-presentation'
import { useFeatureWallCompletion } from './use-feature-wall-completion'
import { FeatureWallBody } from './FeatureWallBody'
import { KeepAwakeCard } from './KeepAwakeCard'
import { FeatureWallRail } from './FeatureWallRail'

const NAVIGATION_KEYS = new Set<string>(['ArrowUp', 'ArrowDown', 'Home', 'End'])
const IS_MAC_PLATFORM = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
export default function FeatureWallModal(): JSX.Element | null {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const isOpen = activeModal === 'feature-wall'
  const assetBaseUrl = useFeatureWallAssetBaseUrl(isOpen)
  const prefersReducedMotion = usePrefersReducedMotion()
  const [selectedId, setSelectedId] = useState<FeatureWallWorkflowId>(
    DEFAULT_FEATURE_WALL_WORKFLOW_ID
  )
  const railRefs = useRef<(HTMLButtonElement | null)[]>([])
  const source = getFeatureWallOpenSource(modalData)
  const telemetryRef = useRef<{ open: boolean; openedAtMs: number }>({
    open: false,
    openedAtMs: 0
  })

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
  const [orchestrationSkillInstalled, setOrchestrationSkillInstalled] = useState(false)
  const completion = useFeatureWallCompletion(
    isOpen,
    taskSourcePresentation.hasConnectedTaskSource,
    taskSourcePresentation.isCheckingTaskSources,
    orchestrationSkillInstalled
  )
  // Reset to the first step whenever the visible step list changes so we never
  // land on an id that's been filtered out (e.g. user toggled notifications on
  // mid-tour).
  useEffect(() => {
    if (!agentsSteps.some((s) => s.id === agentsStepId)) {
      setAgentsStepId(agentsSteps[0]?.id ?? 'statuses')
    }
  }, [agentsSteps, agentsStepId])
  useEffect(() => {
    if (!workbenchSteps.some((s) => s.id === workbenchStepId)) {
      setWorkbenchStepId(workbenchSteps[0]?.id ?? 'terminal')
    }
  }, [workbenchSteps, workbenchStepId])
  useEffect(() => {
    if (!reviewSteps.some((s) => s.id === reviewStepId)) {
      setReviewStepId(reviewSteps[0]?.id ?? 'notes')
    }
  }, [reviewSteps, reviewStepId])
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
  const emitCloseTelemetry = useCallback(() => {
    if (!telemetryRef.current.open) {
      return
    }
    const dwellMs = Math.min(
      FEATURE_WALL_MAX_DWELL_MS,
      Math.max(0, Math.round(performance.now() - telemetryRef.current.openedAtMs))
    )
    track('feature_wall_closed', { dwell_ms: dwellMs })
    telemetryRef.current.open = false
  }, [])

  useEffect(() => {
    if (isOpen && !telemetryRef.current.open) {
      telemetryRef.current = { open: true, openedAtMs: performance.now() }
      track('feature_wall_opened', { source })
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
      return
    }
    if (!isOpen) {
      emitCloseTelemetry()
    }
  }, [emitCloseTelemetry, isOpen, source])
  useEffect(() => {
    return () => emitCloseTelemetry()
  }, [emitCloseTelemetry])

  // Reset selection on close so reopening lands on the default workflow.
  useEffect(() => {
    if (!isOpen) {
      setSelectedId(DEFAULT_FEATURE_WALL_WORKFLOW_ID)
      setAgentsStepId(agentsSteps[0]?.id ?? 'statuses')
      setWorkbenchStepId(workbenchSteps[0]?.id ?? 'terminal')
      setReviewStepId(reviewSteps[0]?.id ?? 'notes')
      setOrchestrationSkillInstalled(false)
    }
  }, [agentsSteps, isOpen, reviewSteps, workbenchSteps])

  // Reset to the first step whenever the agents-orchestration workflow gets
  // selected, so the user always lands on Statuses first.
  useEffect(() => {
    if (selected.id === 'agents-orchestration') {
      setAgentsStepId(agentsSteps[0]?.id ?? 'statuses')
    }
  }, [agentsSteps, selected.id])
  useEffect(() => {
    if (selected.id === 'workbench') {
      setWorkbenchStepId(workbenchSteps[0]?.id ?? 'terminal')
    }
  }, [selected.id, workbenchSteps])
  useEffect(() => {
    if (selected.id === 'review') {
      setReviewStepId(reviewSteps[0]?.id ?? 'notes')
    }
  }, [reviewSteps, selected.id])

  // Why: viewing an informational workflow / sub-step is enough to count it as
  // "done" — only setup-driven entries wait for an external signal (see
  // use-feature-wall-completion.ts).
  const {
    markWorkflowVisited,
    markAgentStepVisited,
    markWorkbenchStepVisited,
    markReviewStepVisited
  } = completion
  useEffect(() => {
    if (isOpen) {
      markWorkflowVisited(selectedId)
    }
  }, [isOpen, markWorkflowVisited, selectedId])
  useEffect(() => {
    if (isOpen && agentsActiveStep) {
      markAgentStepVisited(agentsActiveStep.id)
    }
  }, [agentsActiveStep, isOpen, markAgentStepVisited])
  useEffect(() => {
    if (isOpen && workbenchActiveStep) {
      markWorkbenchStepVisited(workbenchActiveStep.id)
    }
  }, [isOpen, markWorkbenchStepVisited, workbenchActiveStep])
  useEffect(() => {
    if (isOpen && reviewActiveStep) {
      markReviewStepVisited(reviewActiveStep.id)
    }
  }, [isOpen, markReviewStepVisited, reviewActiveStep])

  const handleSelect = useCallback(
    (workflow: FeatureWallWorkflow): void => {
      if (workflow.id === selectedId) {
        return
      }
      setSelectedId(workflow.id)
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
    [selectedId, source]
  )

  const handleOrchestrationSkillInstalledChange = useCallback((installed: boolean): void => {
    setOrchestrationSkillInstalled(installed)
  }, [])

  const handleRailKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (!NAVIGATION_KEYS.has(event.key)) {
      return
    }
    event.preventDefault()
    const nextIndex = getFeatureWallRailNavigationTarget({
      currentIndex: index,
      key: event.key as FeatureWallRailNavigationKey,
      itemCount: FEATURE_WALL_WORKFLOWS.length
    })
    const nextWorkflow = FEATURE_WALL_WORKFLOWS[nextIndex]
    if (!nextWorkflow) {
      return
    }
    handleSelect(nextWorkflow)
    railRefs.current[nextIndex]?.focus()
  }

  const isLastWorkflow = selectedIndex >= FEATURE_WALL_WORKFLOWS.length - 1
  const continueLabel = isLastWorkflow ? 'Done' : 'Continue'
  const handleContinue = useCallback((): void => {
    if (isLastWorkflow) {
      closeModal()
      return
    }
    const nextWorkflow = FEATURE_WALL_WORKFLOWS[selectedIndex + 1]
    if (nextWorkflow) {
      handleSelect(nextWorkflow)
      railRefs.current[selectedIndex + 1]?.focus()
    }
  }, [closeModal, handleSelect, isLastWorkflow, selectedIndex])

  useEffect(() => {
    if (!isOpen) {
      return
    }
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      const mod = IS_MAC_PLATFORM ? event.metaKey : event.ctrlKey
      if (mod && event.key === 'Enter') {
        event.preventDefault()
        handleContinue()
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [handleContinue, isOpen])

  const handleOpenChange = (open: boolean): void => {
    if (!open) {
      closeModal()
    }
  }

  if (!isOpen && !telemetryRef.current.open) {
    return null
  }

  const showGif = !prefersReducedMotion && gifUrl !== null
  const previewTitleId = `feature-wall-preview-${selected.id}`
  const previewPanelId = 'feature-wall-preview-panel'
  const showKeepAwakeCard =
    selected.id === 'agents-orchestration' &&
    agentsActiveStep?.id === 'statuses' &&
    settings != null
  const bodyShowsSectionIntro =
    selected.id === 'workspaces' ||
    selected.id === 'tasks' ||
    agentsActiveStep !== null ||
    workbenchActiveStep !== null ||
    reviewActiveStep !== null

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className="grid h-[min(780px,calc(100vh-8rem))] w-[calc(100vw-8rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0 sm:max-w-[1240px]"
        tabIndex={-1}
      >
        <DialogHeader className="gap-1 border-b border-border px-7 py-4">
          <DialogTitle className="text-lg">Get to know Orca</DialogTitle>
          {/* Why: Radix requires a description for the dialog to be a11y-compliant,
              but we don't want it visible — the rail and step copy already orient users. */}
          <DialogDescription className="sr-only">
            A short, workflow-by-workflow tour of Orca.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[260px_minmax(0,1fr)] md:grid-rows-1 lg:grid-cols-[280px_minmax(0,1fr)]">
          <div className="min-h-0 md:border-r md:border-border">
            <FeatureWallRail
              selectedId={selectedId}
              previewPanelId={previewPanelId}
              railRefs={railRefs}
              onSelect={handleSelect}
              onRailKeyDown={handleRailKeyDown}
              workflowDone={completion.workflowDone}
              agentsSteps={agentsSteps}
              agentsActiveStepId={agentsActiveStep?.id ?? null}
              agentStepDone={completion.agentStepDone}
              onSelectAgentsStep={setAgentsStepId}
              workbenchSteps={workbenchSteps}
              workbenchActiveStepId={workbenchActiveStep?.id ?? null}
              workbenchStepDone={completion.workbenchStepDone}
              onSelectWorkbenchStep={setWorkbenchStepId}
              reviewSteps={reviewSteps}
              reviewActiveStepId={reviewActiveStep?.id ?? null}
              reviewStepDone={completion.reviewStepDone}
              onSelectReviewStep={setReviewStepId}
            />
          </div>

          <section
            id={previewPanelId}
            role="tabpanel"
            className={cn(
              'scrollbar-sleek grid min-h-0 overflow-y-auto',
              showKeepAwakeCard
                ? 'grid-rows-[auto_minmax(0,1fr)_auto]'
                : 'grid-rows-[auto_minmax(0,1fr)]'
            )}
            aria-labelledby={previewTitleId}
          >
            <div className="px-9 pb-3 pt-7">
              <h3
                id={previewTitleId}
                className="text-3xl font-semibold leading-tight tracking-tight"
              >
                {selected.title}
              </h3>
              {bodyShowsSectionIntro ? null : (
                <p className="mt-3 text-lg leading-relaxed text-muted-foreground">
                  {selectedPresentation.lede}
                </p>
              )}
            </div>

            <FeatureWallBody
              selected={selected}
              selectedPresentation={selectedPresentation}
              posterUrl={posterUrl}
              gifUrl={gifUrl}
              showGif={showGif}
              prefersReducedMotion={prefersReducedMotion}
              source={source}
              agentsActiveStep={agentsActiveStep}
              workbenchActiveStep={workbenchActiveStep}
              reviewActiveStep={reviewActiveStep}
              onOrchestrationSkillInstalledChange={handleOrchestrationSkillInstalledChange}
            />
            {showKeepAwakeCard && settings ? (
              <div className="px-9 pb-9">
                <KeepAwakeCard settings={settings} updateSettings={updateSettings} />
              </div>
            ) : null}
          </section>
        </div>

        <footer className="flex items-center justify-between border-t border-border bg-card/50 px-4 py-3 sm:px-7">
          <span className="text-xs text-muted-foreground">
            Reopen any time from Help &gt; Explore Orca.
          </span>
          <button
            type="button"
            className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            onClick={handleContinue}
          >
            {continueLabel}
            <span className="ml-1 inline-flex items-center gap-0.5 rounded border border-primary-foreground/20 px-1.5 py-0.5 text-[10px] font-medium leading-none text-current/80">
              <span>{IS_MAC_PLATFORM ? '⌘' : 'Ctrl'}</span>
              <CornerDownLeft className="size-3" />
            </span>
          </button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
