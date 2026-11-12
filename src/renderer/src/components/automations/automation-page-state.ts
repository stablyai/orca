/** Detail-pane sub-page: the automation's settings, or its full run history. */
export type AutomationPaneTab = 'overview' | 'runs'

/** Top-level surface within Automations. */
export type AutomationsPageView = 'automations' | 'runs' | 'run'

export type {
  AutomationRunPageOrigin,
  AutomationsPageLocation
} from '../../store/slices/ui/automations-page-location'

/** A deep link whose run (or automation) is gone; the page says so instead of a toast. */
export type AutomationRunNotFound = {
  kind: 'run' | 'automation'
  automationId: string
}

/** Run now was requested here; the button stays busy until the new run is listed. */
export type AutomationRunNowPending = {
  rowKey: string
  requestedAt: number
  acknowledgedAt: number | null
  /** The run the host returned, when it returned one. */
  runId: string | null
}
