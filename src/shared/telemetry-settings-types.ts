import type { AgentDashboardSurface } from './telemetry-agent-dashboard-event-schemas'

export type TelemetrySettings = {
  /** New users: true at install. Existing users: null until they resolve the first-launch banner. */
  optedIn: boolean | null
  /** Anonymous UUID v4. Generated on first run. Stable across launches; not surfaced in the UI. */
  installId: string
  /** Cohort marker: true for pre-existing profiles (gates the opt-in banner), false for fresh installs. */
  existedBeforeTelemetryRelease: boolean
  /** Frozen 50/50 assignment for fresh installs; absent for profiles predating the experiment. */
  onboardingLanguageCohort?: 'control' | 'treatment'
  /** Local UTC-day cursors cap dashboard observations across restarts; at most two writes a day. */
  agentDashboardActiveDays?: Partial<Record<AgentDashboardSurface, number>>
}
