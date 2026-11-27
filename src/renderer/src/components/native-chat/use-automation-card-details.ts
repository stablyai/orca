import { useCallback, useEffect, useRef, useState } from 'react'
import { AUTOMATIONS_CHANGED_EVENT } from '@/components/automations/events/automations-changed-window-event'
import {
  isAutomationNotFoundError,
  listRecentAutomationRunsForTarget,
  showAutomationForTarget,
  type AutomationHostTarget
} from '@/components/automations/hosts/automation-host-client'
import type { Automation } from '../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'

export const AUTOMATION_CARD_RECENT_RUNS = 3

export type AutomationCardDetails =
  | { status: 'loading' }
  | { status: 'deleted' }
  | { status: 'error' }
  | { status: 'ready'; automation: Automation; runs: AutomationRun[] }

/** An opened card's automation and newest runs from its host; re-read when automations change, never polled. */
export function useAutomationCardDetails(
  /** The chat's host; null for this computer. */
  environmentId: string | null,
  automationId: string
): {
  details: AutomationCardDetails
  reload: () => void
  replace: (next: Automation) => void
} {
  const [details, setDetails] = useState<AutomationCardDetails>({
    status: 'loading'
  })
  const reads = useRef(0)
  const load = useCallback(async (): Promise<void> => {
    // Only the latest read lands, so a slow earlier one cannot overwrite it.
    const read = ++reads.current
    const target: AutomationHostTarget =
      environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }
    try {
      const [automation, runs] = await Promise.all([
        showAutomationForTarget(target, automationId),
        listRecentAutomationRunsForTarget(target, automationId, AUTOMATION_CARD_RECENT_RUNS)
      ])
      if (read === reads.current) {
        setDetails({ status: 'ready', automation, runs })
      }
    } catch (error) {
      if (read === reads.current) {
        setDetails({
          status: isAutomationNotFoundError(error) ? 'deleted' : 'error'
        })
      }
    }
  }, [automationId, environmentId])

  useEffect(() => {
    void load()
    const reload = (): void => void load()
    window.addEventListener(AUTOMATIONS_CHANGED_EVENT, reload)
    return () => {
      window.removeEventListener(AUTOMATIONS_CHANGED_EVENT, reload)
      // Nothing lands after the card closes.
      reads.current += 1
    }
  }, [load])

  const replace = useCallback((next: Automation) => {
    setDetails((current) =>
      current.status === 'ready' ? { ...current, automation: next } : current
    )
  }, [])
  return { details, reload: () => void load(), replace }
}
