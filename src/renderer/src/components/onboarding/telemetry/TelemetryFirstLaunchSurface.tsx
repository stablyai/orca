import { Suspense, useState } from 'react'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useAppStore } from '../../../store/index'

const LazyFirstLaunchBanner = lazyWithRetry(
  () => import('./FirstLaunchBanner').then((module) => ({ default: module.FirstLaunchBanner })),
  { reloadKey: 'telemetry-first-launch-banner' }
)

export function TelemetryFirstLaunchSurface(): React.JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  // Rebase to main's saved consent after the IPC write, including when a mutation was rejected.
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const [dismissedThisSession, setDismissedThisSession] = useState(false)

  if (!settings || dismissedThisSession) {
    return null
  }

  const telemetry = settings.telemetry
  if (!telemetry) {
    // Missing consent data cannot safely identify the cohort.
    return null
  }

  const isExistingUserAwaitingBanner =
    telemetry.existedBeforeTelemetryRelease === true && telemetry.optedIn === null
  if (!isExistingUserAwaitingBanner) {
    return null
  }

  return (
    <Suspense fallback={null}>
      <LazyFirstLaunchBanner
        fetchSettings={fetchSettings}
        onResolve={() => setDismissedThisSession(true)}
      />
    </Suspense>
  )
}
