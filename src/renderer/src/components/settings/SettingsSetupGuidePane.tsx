import { EyeOff, RefreshCw, RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  getFeatureWallSetupSteps,
  getFirstIncompleteFeatureWallSetupStepId
} from '../../../../shared/feature-wall-setup-steps'
import type { FeatureWallSetupStepId } from '../../../../shared/feature-wall-setup-steps'
import { FeatureWallSetupChecklist } from '../feature-wall/FeatureWallSetupChecklist'
import { useSettingsSetupGuideFullProgress } from './settings-setup-guide-progress'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'

export function SettingsSetupGuidePane(): React.JSX.Element {
  const setupSteps = useMemo(() => getFeatureWallSetupSteps(), [])
  const [userSelectedStep, setUserSelectedStep] = useState(false)
  const [orchestrationSkillInstalled, setOrchestrationSkillInstalled] = useState(false)
  const [browserUseSkillInstalled, setBrowserUseSkillInstalled] = useState(false)
  const [checklistHidden, setChecklistHidden] = useState(false)
  const [checklistVisibilityLoaded, setChecklistVisibilityLoaded] = useState(false)
  const [checklistVisibilityLoadFailed, setChecklistVisibilityLoadFailed] = useState(false)
  const [checklistVisibilityLoadAttempt, setChecklistVisibilityLoadAttempt] = useState(0)
  const [dismissalUpdating, setDismissalUpdating] = useState(false)
  const dismissalIntentRef = useRef<boolean | null>(null)
  const progress = useSettingsSetupGuideFullProgress(
    true,
    orchestrationSkillInstalled,
    browserUseSkillInstalled
  )
  const [activeStepId, setActiveStepId] = useState<FeatureWallSetupStepId>(() =>
    getFirstIncompleteFeatureWallSetupStepId(progress.stepDone)
  )
  const activeStep = setupSteps.find((step) => step.id === activeStepId) ?? setupSteps[0] ?? null

  useEffect(() => {
    let mounted = true
    void window.api.ui
      .get()
      .then((onboarding) => {
        if (mounted && dismissalIntentRef.current === null) {
          setChecklistHidden(onboarding.setupGuideSettingsDismissed === true)
          setChecklistVisibilityLoadFailed(false)
          setChecklistVisibilityLoaded(true)
        }
      })
      .catch((error) => {
        console.error('Failed to load onboarding checklist visibility:', error)
        if (mounted) {
          setChecklistVisibilityLoadFailed(true)
          setChecklistVisibilityLoaded(true)
        }
      })
    return () => {
      mounted = false
    }
  }, [checklistVisibilityLoadAttempt])

  useEffect(() => {
    if (userSelectedStep) {
      return
    }
    setActiveStepId(getFirstIncompleteFeatureWallSetupStepId(progress.stepDone))
  }, [progress.stepDone, userSelectedStep])

  useEffect(() => {
    if (!activeStep || userSelectedStep || !progress.stepDone[activeStep.id]) {
      return
    }
    const nextUnfinishedStepId = getFirstIncompleteFeatureWallSetupStepId(progress.stepDone)
    if (nextUnfinishedStepId !== activeStep.id) {
      setActiveStepId(nextUnfinishedStepId)
    }
  }, [activeStep, progress.stepDone, userSelectedStep])

  const handleSelectStep = (id: FeatureWallSetupStepId): void => {
    setUserSelectedStep(true)
    setActiveStepId(id)
  }

  const handleChecklistDismissal = async (dismissed: boolean): Promise<void> => {
    dismissalIntentRef.current = dismissed
    setDismissalUpdating(true)
    try {
      await window.api.ui.set({ setupGuideSettingsDismissed: dismissed })
      setChecklistHidden(dismissed)
      setChecklistVisibilityLoaded(true)
    } catch (error) {
      console.error('Failed to update onboarding checklist visibility:', error)
    } finally {
      setDismissalUpdating(false)
    }
  }

  if (checklistHidden) {
    return (
      <div className="flex h-[min(740px,calc(100vh-14rem))] min-h-[540px] items-center justify-center px-7 py-6">
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <EyeOff className="size-5 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {translate(
              'auto.components.settings.SettingsSetupGuidePane.checklistHiddenDescription',
              'The onboarding checklist is hidden. You can show it again whenever you need it.'
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={dismissalUpdating}
            onClick={() => void handleChecklistDismissal(false)}
          >
            <RotateCcw />
            {translate(
              'auto.components.settings.SettingsSetupGuidePane.showChecklist',
              'Show checklist'
            )}
          </Button>
        </div>
      </div>
    )
  }

  if (!checklistVisibilityLoaded) {
    return (
      <div
        className="h-[min(740px,calc(100vh-14rem))] min-h-[540px]"
        role="status"
        aria-busy="true"
        aria-label={translate(
          'auto.components.settings.SettingsSetupGuidePane.loadingChecklist',
          'Loading onboarding checklist'
        )}
      />
    )
  }

  if (checklistVisibilityLoadFailed) {
    return (
      <div className="flex h-[min(740px,calc(100vh-14rem))] min-h-[540px] items-center justify-center px-7 py-6">
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <p className="text-sm text-muted-foreground">
            {translate(
              'auto.components.settings.SettingsSetupGuidePane.loadFailedDescription',
              'The onboarding checklist visibility could not be loaded.'
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setChecklistVisibilityLoaded(false)
              setChecklistVisibilityLoadFailed(false)
              setChecklistVisibilityLoadAttempt((attempt) => attempt + 1)
            }}
          >
            <RefreshCw />
            {translate('auto.components.settings.SettingsSetupGuidePane.retry', 'Retry')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="h-[min(740px,calc(100vh-14rem))] min-h-[540px] px-7 py-6">
      <div className="mb-4 flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={dismissalUpdating}
          onClick={() => void handleChecklistDismissal(true)}
        >
          <EyeOff />
          {translate(
            'auto.components.settings.SettingsSetupGuidePane.hideChecklist',
            'Hide checklist'
          )}
        </Button>
      </div>
      <FeatureWallSetupChecklist
        layout="embedded"
        activeStep={activeStep}
        progress={progress}
        onSelectStep={handleSelectStep}
        onOrchestrationSkillInstalledChange={setOrchestrationSkillInstalled}
        onBrowserUseSkillInstalledChange={setBrowserUseSkillInstalled}
      />
    </div>
  )
}
