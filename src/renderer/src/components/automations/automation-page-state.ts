/** Detail-pane sub-page: the automation's settings, or its full run history. */
export type AutomationPaneTab = 'overview' | 'runs'

/** Top-level surface within Automations. */
export type AutomationsPageView = 'automations' | 'runs' | 'run'

import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { AutomationRunPageOrigin } from '../../store/slices/ui/automations-page-location'

export type {
  AutomationRunPageOrigin,
  AutomationsPageLocation
} from '../../store/slices/ui/automations-page-location'

/** A deep link whose run (or automation) is gone; the page says so instead of a toast. */
export type AutomationRunNotFound = {
  kind: 'run' | 'automation'
  automationId: string
  /** The requested run, so Back/Forward can return to this same (missing) destination. */
  runId: string | null
  hostId?: ExecutionHostId
  origin?: AutomationRunPageOrigin
}

/** Run now was requested here; the button stays busy until the new run is listed. */
export type AutomationRunNowPending = {
  /** This click's request; a late answer to an earlier click must not touch it. */
  requestId: string
  rowKey: string
  requestedAt: number
  acknowledgedAt: number | null
  /** The run the host returned, when it returned one. */
  runId: string | null
}

/** Run now requests in flight, one per automation row, so each row keeps its own busy state. */
export type AutomationRunNowPendingByRow = Readonly<Record<string, AutomationRunNowPending>>
