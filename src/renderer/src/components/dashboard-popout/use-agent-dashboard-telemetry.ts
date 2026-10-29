import { useEffect } from 'react'
import type { AgentDashboardSurface } from '../../../../shared/telemetry-agent-dashboard-event-schemas'
import { getConsentState, track, trackWithResult } from '@/lib/telemetry'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { useAppStore } from '@/store'

export function useAgentDashboardTelemetry(surface: AgentDashboardSurface): void {
  const optedIn = useAppStore((state) => state.settings?.telemetry?.optedIn)
  useEffect(() => {
    track('agent_dashboard_opened', { surface })
  }, [surface])

  useEffect(() => {
    let disposed = false
    let stopObserving: (() => void) | undefined
    let lastObservedDay = -1
    let inFlight = false
    const observe = (): void => {
      const day = Math.floor(Date.now() / 86_400_000)
      if (day === lastObservedDay || inFlight) {
        return
      }
      inFlight = true
      void trackWithResult('agent_dashboard_active', { surface }).then((recorded) => {
        inFlight = false
        if (!disposed && recorded !== false) {
          lastObservedDay = day
        }
      })
    }
    void getConsentState().then((consent) => {
      if (disposed || consent.effective !== 'enabled') {
        return
      }
      stopObserving = installWindowVisibilityInterval({
        run: observe,
        intervalMs: 60_000
      })
    })
    return () => {
      disposed = true
      stopObserving?.()
    }
  }, [surface, optedIn])
}
