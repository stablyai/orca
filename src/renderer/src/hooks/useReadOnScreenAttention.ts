import { useEffect } from 'react'
import { subscribeStructuredAttentionViews } from '@/attention/agent-subject-read-actions'
import { subscribeAutoAckPresenceSignals } from './agent-auto-ack-presence'
import { useAppStore } from '@/store'
import { isWebClientLocation } from '@/lib/web-client-location'
import { startOnScreenAttentionScan } from './on-screen-attention-scan'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-inputs-switch'
import {
  createClientWorkspaceViewReporter,
  subscribeViewReportPresenceSignals
} from './client-workspace-view-report'

export function useReadOnScreenAttention(): void {
  useEffect(
    () =>
      startOnScreenAttentionScan(useAppStore, {
        readDesktopAway: isWebClientLocation()
          ? null
          : async () => window.api?.notifications?.getDesktopAwayState?.(),
        subscribeStructuredViews: subscribeStructuredAttentionViews,
        ...(ORCA_SIDEBAR_INPUTS_IS_MAIN
          ? {
              subscribePresenceSignals: subscribeViewReportPresenceSignals,
              viewReporter: createClientWorkspaceViewReporter()
            }
          : { subscribePresenceSignals: subscribeAutoAckPresenceSignals })
      }),
    []
  )
}
