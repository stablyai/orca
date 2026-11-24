import { useEffect } from 'react'
import { onRuntimeEnvironmentRevisionsChanged } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { useAppStore } from '@/store/index'
import { isWindowVisible } from '@/lib/window-activity/window-visibility-interval'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { createVisibleHostedReviewRefreshScheduler } from '@/store/slices/hosted-review/refresh/visible-hosted-review-refresh-scheduler'
import { followOwningHostCadence } from '@/store/slices/hosted-review/refresh/owning-host-cadence-replan'
import { createWorkspaceReferenceRefreshTargetsSelector } from '@/components/sidebar/workspace-card/review/workspace-reference-refresh-targets'
import {
  getVisibleHostedReviewRefreshTargets,
  visibleHostedReviewRefreshInputsChanged
} from '@/store/slices/hosted-review/refresh/visible-hosted-review-refresh-targets'

export function useVisibleHostedReviewRefresh({ enabled }: { enabled: boolean }): void {
  useEffect(() => {
    if (!enabled) {
      return
    }
    const scheduler = createVisibleHostedReviewRefreshScheduler()
    const selectedOnly = isWebClientLocation()
    const selectReferences = createWorkspaceReferenceRefreshTargetsSelector({ selectedOnly })
    let hostedTargets: ReturnType<typeof getVisibleHostedReviewRefreshTargets> = []
    let referenceTargets: ReturnType<typeof selectReferences> = []
    let referenceInputs = referenceTargets
    const { update: applyTargets, dispose: stopFollowingCadence } = followOwningHostCadence(
      () => [...hostedTargets, ...referenceTargets],
      (targets) => {
        // Keep the cached targets at the host's current cadence without rebuilding their inputs.
        referenceTargets = targets.slice(hostedTargets.length)
        hostedTargets = targets.slice(0, hostedTargets.length)
        scheduler.update(targets)
      }
    )
    const update = (reviewInputsChanged: boolean): void => {
      if (!isWindowVisible()) {
        return
      }
      const state = useAppStore.getState()
      const references = selectReferences(state, reviewInputsChanged)
      if (!reviewInputsChanged && references === referenceInputs) {
        return
      }
      referenceInputs = references
      referenceTargets = references
      if (reviewInputsChanged) {
        hostedTargets = getVisibleHostedReviewRefreshTargets(state, useAppStore.getState, {
          selectedOnly
        })
      }
      applyTargets()
    }
    const visibilityChanged = (): void => {
      scheduler.setVisible(false)
      update(true)
      scheduler.setVisible(isWindowVisible())
    }
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      update(visibleHostedReviewRefreshInputsChanged(state, previous))
    })
    const stopRevisionChanges = onRuntimeEnvironmentRevisionsChanged(() => update(true))
    visibilityChanged()
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      unsubscribe()
      stopRevisionChanges()
      stopFollowingCadence()
      document.removeEventListener('visibilitychange', visibilityChanged)
      scheduler.dispose()
    }
  }, [enabled])
}
