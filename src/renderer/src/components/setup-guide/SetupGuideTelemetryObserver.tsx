import { useLayoutEffect } from 'react'
import { useAppStore } from '@/store'
import { useSetupGuideProgress } from './use-setup-guide-progress'
import { useSetupGuideStepCompletionTelemetry } from './use-setup-guide-telemetry'
import { publishSetupGuideProgress } from './setup-guide-progress-snapshot'

export function SetupGuideTelemetryObserver(): null {
  const setupGuideVisible = useAppStore((s) => s.activeModal === 'setup-guide')
  const progress = useSetupGuideProgress(true, false, false)

  useSetupGuideStepCompletionTelemetry({
    progress,
    setupGuideVisible
  })

  // This observer already runs for the whole session; sharing its reading spares other surfaces their own checks.
  const { ready, coreDoneCount: done, coreTotal: total } = progress
  useLayoutEffect(() => {
    publishSetupGuideProgress({ ready, done, total })
  }, [ready, done, total])
  useLayoutEffect(() => () => publishSetupGuideProgress(null), [])

  return null
}
