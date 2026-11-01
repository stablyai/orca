import type { AgentDashboardSurface } from './telemetry-agent-dashboard-event-schemas'

export type ChatUiLaunchTipTargeting =
  | { mode: 'all' }
  | { mode: 'eligible-harnesses'; eligible: boolean }

export type TelemetrySettings = {
  /** New users: true at install. Existing users: null until they resolve the first-launch banner. */
  optedIn: boolean | null
  /** Anonymous UUID v4. Generated on first run. Stable across launches; not surfaced in the UI. */
  installId: string
  /** Cohort marker: true for pre-existing profiles (gates the opt-in banner), false for fresh installs. */
  existedBeforeTelemetryRelease: boolean
  /** Frozen 50/50 assignment for fresh installs; absent for profiles predating the experiment. */
  onboardingLanguageCohort?: 'control' | 'treatment'
  /** Frozen 80% control / 20% treatment assignment for the Chat UI launch tip; control never sees it. Absent means not enrolled, so the tip shows. */
  chatUiLaunchTipCohort?: 'control' | 'treatment'
  /** Treatment splits equally per card; eligibility is frozen locally from settings, never usage history. */
  chatUiLaunchTipTargeting?: ChatUiLaunchTipTargeting
  /** Local UTC-day cursors cap dashboard observations across restarts; at most two writes a day. */
  agentDashboardActiveDays?: Partial<Record<AgentDashboardSurface, number>>
}
