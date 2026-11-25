import { useEffect, useSyncExternalStore } from 'react'
import { isFinalAutomationRunStatus } from '../../../../../shared/automations/history/automation-run'
import type { AutomationDetailsController } from './automation-details-controller'
import type { AutomationDetailsSnapshot } from './automation-details-model'
import { automationRunAttempts } from './automation-run-attempts'

export function useAutomationRunAttempt(
  controller: AutomationDetailsController,
  snapshot: AutomationDetailsSnapshot
) {
  const attempt = useSyncExternalStore(automationRunAttempts.subscribe, () =>
    automationRunAttempts.get(snapshot.owner, controller.automationId)
  )
  useEffect(() => {
    if (
      snapshot.continuity === 'retired' ||
      snapshot.continuity === 'unpaired' ||
      snapshot.definition.status === 'deleted'
    ) {
      automationRunAttempts.retire(snapshot.owner, controller.automationId)
    } else if (attempt?.run && snapshot.continuity === 'same') {
      const published = snapshot.runs.value.find((run) => run.id === attempt.run?.id)
      if (published && isFinalAutomationRunStatus(published.status) && !snapshot.acknowledgedRun) {
        automationRunAttempts.retire(snapshot.owner, controller.automationId)
      } else if (!snapshot.acknowledgedRun && !published) {
        controller.acknowledgeRun(attempt.run)
        void controller.refreshRuns()
      }
    }
  }, [attempt, controller, snapshot])
  return attempt
}
