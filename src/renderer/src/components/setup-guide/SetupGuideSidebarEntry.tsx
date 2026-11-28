import React, { Suspense } from 'react'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useAppStore } from '@/store/index'
import type { FeatureWallSetupStepId } from '../../../../shared/feature-education/explore/feature-wall-setup-steps'
import type { FeatureWallSetupProgress } from '../feature-wall/setup/feature-wall-setup-progress'
import { useSetupGuideProgress } from '../setup-guide/use-setup-guide-progress'

const LazySetupGuideSidebarEntryBody = lazyWithRetry(
  () =>
    import('./SetupGuideSidebarEntryBody').then((module) => ({
      default: module.SetupGuideSidebarEntryBody
    })),
  { reloadKey: 'setup-guide-sidebar-entry-body' }
)

export type SetupGuideEntryVisibilityInput = {
  ready: boolean
  setupComplete: boolean
  dismissed: boolean
}

export function shouldShowSetupGuideEntry(input: SetupGuideEntryVisibilityInput): boolean {
  return input.ready && !input.setupComplete && !input.dismissed
}

export function getSetupGuideSidebarEntryReady(
  persistedUIReady: boolean,
  setupProgressReady: boolean
): boolean {
  return persistedUIReady && setupProgressReady
}

function isSetupGuideSidebarComplete(progress: FeatureWallSetupProgress): boolean {
  return progress.coreDoneCount >= progress.coreTotal
}

export function SetupGuideSidebarEntry(): React.JSX.Element | null {
  const openModal = useAppStore((s) => s.openModal)
  const activeModal = useAppStore((s) => s.activeModal)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const setupGuideSidebarDismissed = useAppStore((s) => s.setupGuideSidebarDismissed)
  const setSetupGuideSidebarDismissed = useAppStore((s) => s.setSetupGuideSidebarDismissed)
  // Warm progress before click so lazy modal mounting cannot change the displayed count.
  const setupProgress = useSetupGuideProgress(true, false, false)
  const setupComplete = isSetupGuideSidebarComplete(setupProgress)
  const setupActive = activeModal === 'setup-guide'
  const showSetupGuideEntry = shouldShowSetupGuideEntry({
    ready: getSetupGuideSidebarEntryReady(persistedUIReady, setupProgress.ready),
    setupComplete,
    dismissed: setupGuideSidebarDismissed
  })
  const [lastVisibleProgress, setLastVisibleProgress] =
    React.useState<FeatureWallSetupProgress | null>(null)
  const rowRef = React.useRef<HTMLDivElement>(null)
  if (showSetupGuideEntry && lastVisibleProgress !== setupProgress) {
    setLastVisibleProgress(setupProgress)
  }
  // Keep an already-visible checklist row stable through host/workspace probe refreshes.
  const renderedProgress = showSetupGuideEntry
    ? setupProgress
    : !setupProgress.ready && !setupGuideSidebarDismissed
      ? lastVisibleProgress
      : null
  const handleOpenSetupGuide = React.useCallback(
    (setupStepId: FeatureWallSetupStepId) => {
      openModal('setup-guide', { setupStepId, telemetrySource: 'sidebar' })
    },
    [openModal]
  )
  const handleHideSetupGuide = React.useCallback(() => {
    const row = rowRef.current
    if (row?.contains(document.activeElement) && row.parentElement) {
      const controls = Array.from(
        row.parentElement.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
      ).filter((button) => button.tabIndex >= 0 && button.getClientRects().length > 0)
      const lastRowControl = controls.findLastIndex((button) => row.contains(button))
      const nextControl =
        controls[lastRowControl + 1] ?? controls.findLast((button) => !row.contains(button))
      nextControl?.focus({ preventScroll: true })
    }
    setSetupGuideSidebarDismissed(true)
  }, [setSetupGuideSidebarDismissed])

  if (!renderedProgress) {
    return null
  }

  return (
    <Suspense fallback={null}>
      <LazySetupGuideSidebarEntryBody
        renderedProgress={renderedProgress}
        setupActive={setupActive}
        rowRef={rowRef}
        onOpenSetupGuide={handleOpenSetupGuide}
        onHideSetupGuide={handleHideSetupGuide}
      />
    </Suspense>
  )
}
