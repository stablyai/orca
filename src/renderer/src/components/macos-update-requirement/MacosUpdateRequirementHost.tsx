import { Suspense, type JSX } from 'react'
import { ModalBoundary } from '@/app-shell/app-root-surface-boundaries'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { useAppStore } from '@/store/index'

const MacosUpdateRequirementNotice = lazy(() => import('./MacosUpdateRequirementNotice'))

/** Loads the notice only once the updater withholds a release this Mac cannot run. */
export function MacosUpdateRequirementHost(): JSX.Element | null {
  const requirement = useAppStore((s) =>
    s.updateStatus.state === 'not-available' ? s.updateStatus.unsupportedSystemUpdate : undefined
  )
  const seen = useAppStore((s) => s.seenMacosUpdateRequirement)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  // A web client's update status describes its host, not the browser's machine.
  if (
    !requirement ||
    !persistedUIReady ||
    isWebClientLocation() ||
    requirement.minimumMacosVersion === seen
  ) {
    return null
  }
  return (
    <Suspense fallback={null}>
      <ModalBoundary boundaryId="modal.macos-update-requirement" resetKey>
        <MacosUpdateRequirementNotice requirement={requirement} />
      </ModalBoundary>
    </Suspense>
  )
}
