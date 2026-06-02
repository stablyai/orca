import { useEffect, useMemo, useState, type JSX } from 'react'
import {
  FEATURE_WALL_SETUP_STEP_IDS,
  getFirstIncompleteFeatureWallSetupStepId,
  getFeatureWallSetupSteps
} from '../../../../shared/feature-wall-setup-steps'
import type { FeatureWallSetupStepId } from '../../../../shared/feature-wall-setup-steps'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useAppStore } from '@/store'
import { FeatureWallSetupChecklist } from '../feature-wall/FeatureWallSetupChecklist'
import { useSetupGuideProgress } from './use-setup-guide-progress'
import { useSetupGuideOpenCloseTelemetry } from './use-setup-guide-telemetry'

export default function SetupGuideModal(): JSX.Element | null {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const isOpen = activeModal === 'setup-guide'
  const setupSteps = useMemo(() => getFeatureWallSetupSteps(), [])
  const [activeStepId, setActiveStepId] = useState<FeatureWallSetupStepId>(
    () => setupSteps[0]?.id ?? 'default-agent'
  )
  const [userSelectedStep, setUserSelectedStep] = useState(false)
  const [orchestrationSkillInstalled, setOrchestrationSkillInstalled] = useState(false)
  const [browserUseSkillInstalled, setBrowserUseSkillInstalled] = useState(false)
  const progress = useSetupGuideProgress(
    isOpen,
    orchestrationSkillInstalled,
    browserUseSkillInstalled
  )
  const requestedStepId = isFeatureWallSetupStepId(modalData.setupStepId)
    ? modalData.setupStepId
    : null
  const telemetrySource =
    typeof modalData.setupGuideSource === 'string'
      ? modalData.setupGuideSource
      : typeof modalData.telemetrySource === 'string'
        ? modalData.telemetrySource
        : 'unknown'
  const activeStep = setupSteps.find((step) => step.id === activeStepId) ?? setupSteps[0] ?? null

  useSetupGuideOpenCloseTelemetry({
    isOpen,
    source: telemetrySource,
    progress,
    activeStepId: activeStep?.id ?? null
  })

  useEffect(() => {
    if (!isOpen) {
      setUserSelectedStep(false)
      return
    }
    if (requestedStepId === null) {
      return
    }
    setUserSelectedStep(false)
    setActiveStepId(requestedStepId)
  }, [isOpen, requestedStepId])

  useEffect(() => {
    if (!isOpen || userSelectedStep || requestedStepId !== null) {
      return
    }
    setActiveStepId(getFirstIncompleteFeatureWallSetupStepId(progress.stepDone))
  }, [isOpen, progress.stepDone, requestedStepId, userSelectedStep])

  useEffect(() => {
    if (
      !isOpen ||
      userSelectedStep ||
      requestedStepId === null ||
      activeStep?.id !== requestedStepId ||
      !progress.stepDone[activeStep.id]
    ) {
      return
    }
    const nextUnfinishedCoreStepId = getFirstIncompleteFeatureWallSetupStepId(progress.stepDone)
    if (nextUnfinishedCoreStepId !== activeStep.id) {
      setActiveStepId(nextUnfinishedCoreStepId)
    }
  }, [activeStep, isOpen, progress.stepDone, requestedStepId, userSelectedStep])

  const handleSelectStep = (id: FeatureWallSetupStepId): void => {
    setUserSelectedStep(true)
    setActiveStepId(id)
  }

  const handleOpenChange = (open: boolean): void => {
    if (!open) {
      closeModal()
    }
  }

  if (!isOpen) {
    return null
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className="grid h-[min(780px,calc(100vh-2rem))] w-[min(1080px,calc(100vw-2rem))] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 p-0 sm:max-w-none"
        tabIndex={-1}
      >
        <DialogHeader className="gap-1 border-b border-border px-7 py-4">
          <div className="flex items-center justify-between gap-4">
            <DialogTitle className="text-lg">Getting started</DialogTitle>
            <span className="mr-7 font-mono text-xs text-muted-foreground">
              {progress.coreDoneCount}/{progress.coreTotal}
            </span>
          </div>
          <DialogDescription className="text-sm text-muted-foreground">
            Finish the core workflows that make Orca useful for parallel agent work.
          </DialogDescription>
        </DialogHeader>
        <div className="scrollbar-sleek min-h-0 overflow-y-auto px-7 py-6">
          <FeatureWallSetupChecklist
            activeStep={activeStep}
            progress={progress}
            onSelectStep={handleSelectStep}
            onOrchestrationSkillInstalledChange={setOrchestrationSkillInstalled}
            onBrowserUseSkillInstalledChange={setBrowserUseSkillInstalled}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

function isFeatureWallSetupStepId(value: unknown): value is FeatureWallSetupStepId {
  return (
    typeof value === 'string' &&
    FEATURE_WALL_SETUP_STEP_IDS.includes(value as FeatureWallSetupStepId)
  )
}
