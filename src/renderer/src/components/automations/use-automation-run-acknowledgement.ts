import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import type { AutomationRun } from '../../../../shared/automations-types'
import type { AutomationCapturedOwner } from './automation-captured-owner'
import {
  markAutomationRunSeen,
  ownerPrecondition,
  ORPHAN_OWNER_PRECONDITION
} from './automation-scoped-list-client'

export function useAutomationRunAcknowledgement(
  run: AutomationRun | null,
  captured: AutomationCapturedOwner,
  visible: boolean
): void {
  const activeView = useAppStore((state) => state.activeView)
  const acknowledgementRequest = useRef<string | null>(null)
  useEffect(() => {
    if (!visible || run?.status !== 'dispatch_failed' || run.failureSeenAt !== undefined) {
      return
    }
    const authority = captured.owner?.authority ?? captured.authority
    if (!authority || (!captured.owner && captured.selector?.kind !== 'orphan')) {
      return
    }
    const requestKey = JSON.stringify([
      authority,
      captured.owner?.selector ?? captured.selector,
      run.id,
      run.createdAt
    ])
    const acknowledge = (): void => {
      if (
        document.visibilityState !== 'visible' ||
        activeView !== 'automations' ||
        acknowledgementRequest.current === requestKey
      ) {
        return
      }
      // Refreshed owner/row objects must not re-submit the same acknowledgement.
      acknowledgementRequest.current = requestKey
      void markAutomationRunSeen(
        authority,
        run.automationId,
        run.id,
        captured.owner ? ownerPrecondition(captured.owner) : ORPHAN_OWNER_PRECONDITION
      ).catch((error) => {
        if (acknowledgementRequest.current === requestKey) {
          acknowledgementRequest.current = null
        }
        console.warn('[automations] Could not mark run seen:', error)
      })
    }
    acknowledge()
    document.addEventListener('visibilitychange', acknowledge)
    return () => document.removeEventListener('visibilitychange', acknowledge)
  }, [activeView, captured, run, visible])
}
