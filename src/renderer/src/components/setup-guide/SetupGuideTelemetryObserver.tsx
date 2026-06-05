import { useAppStore } from '@/store'
import { useSetupGuideProgress } from './use-setup-guide-progress'
import { useSetupGuideStepCompletionTelemetry } from './use-setup-guide-telemetry'

export function SetupGuideTelemetryObserver(): null {
  const setupGuideVisible = useAppStore((s) => s.activeModal === 'setup-guide')
  const progress = useSetupGuideProgress(true, false, false)

  useSetupGuideStepCompletionTelemetry({
    progress,
    setupGuideVisible
  })

  return null
}
