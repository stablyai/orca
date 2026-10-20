import { useEffect } from 'react'
import { subscribeStructuredAttentionViews } from '@/attention/agent-subject-read-actions'
import { useAppStore } from '@/store'
import { isWebClientLocation } from '@/lib/web-client-location'
import { startOnScreenAttentionScan } from './on-screen-attention-scan'
import {
  createClientWorkspaceViewReporter,
  subscribeViewReportPresenceSignals
} from './client-workspace-view-report'

/** Reads what is on screen: acknowledges the visible agents and reads the visible tabs' markers. */
export function useReadOnScreenAttention(): void {
  useEffect(
    () =>
      startOnScreenAttentionScan(useAppStore, {
        readDesktopAway: isWebClientLocation()
          ? null
          : async () => window.api?.notifications?.getDesktopAwayState?.(),
        subscribeStructuredViews: subscribeStructuredAttentionViews,
        // The owning hosts raise the unread flag, so they learn what is on screen.
        subscribePresenceSignals: subscribeViewReportPresenceSignals,
        viewReporter: createClientWorkspaceViewReporter()
      }),
    []
  )
}
