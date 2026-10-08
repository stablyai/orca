import { Suspense, useEffect, useRef, useState } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { useAppStore } from '@/store'
import { useDialogRegistry } from '@/store/dialog-registry'
import { DialogEntryScope, useAutomaticDialogEntry } from '@/lib/dialog-registry-entry'
import { RecoverableRenderErrorBoundary } from '../error-boundaries/RecoverableRenderErrorBoundary'
import type { FeatureTipId } from '../../../../shared/feature-tips'
import { APP_OPEN_FEATURE_TIP_TOKEN } from './feature-tip-startup-gate'
import {
  trackCmdJPaletteFeatureTipShown,
  trackOrcaCliFeatureTipShown
} from './feature-tip-telemetry'

const FeatureTipDialogs = lazy(() =>
  import('./FeatureTipsModal').then((module) => ({ default: module.FeatureTipDialogs }))
)

/**
 * The tip the app offers by itself at launch. It waits its turn among the dialogs that open by
 * themselves and renders here, not in the modal slot, so a dialog the user opens stacks over it
 * rather than replacing it.
 */
export function AppOpenFeatureTip({ tipId }: { tipId: FeatureTipId }): React.JSX.Element | null {
  const [closed, setClosed] = useState(false)
  const phase = useAutomaticDialogEntry(
    APP_OPEN_FEATURE_TIP_TOKEN,
    'feature-tip',
    closed ? null : 'automatic'
  )
  const markFeatureTipsSeen = useAppStore((s) => s.markFeatureTipsSeen)

  const shownRef = useRef(false)
  useEffect(() => {
    if (phase !== 'visible' || shownRef.current) {
      return
    }
    shownRef.current = true
    if (tipId === 'orca-cli') {
      trackOrcaCliFeatureTipShown('app_open')
    } else if (tipId === 'cmd-j-palette') {
      trackCmdJPaletteFeatureTipShown('app_open')
    }
    // Why: marked seen once on screen, so a quit/crash before dismiss doesn't reappear it next
    // launch, while one that never got its turn is still offered next time.
    markFeatureTipsSeen([tipId])
  }, [markFeatureTipsSeen, phase, tipId])

  if (phase === null || phase === 'queued') {
    return null
  }
  return (
    <DialogEntryScope token={APP_OPEN_FEATURE_TIP_TOKEN}>
      <RecoverableRenderErrorBoundary
        boundaryId="modal.app-open-feature-tip"
        surface="modal"
        compact
        onError={() => useDialogRegistry.getState().endDialog(APP_OPEN_FEATURE_TIP_TOKEN)}
      >
        <Suspense fallback={null}>
          <FeatureTipDialogs
            open={phase !== 'closing'}
            tipId={tipId}
            onClose={() => setClosed(true)}
          />
        </Suspense>
      </RecoverableRenderErrorBoundary>
    </DialogEntryScope>
  )
}
