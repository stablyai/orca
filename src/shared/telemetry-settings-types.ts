import type { AgentDashboardSurface } from './telemetry-agent-dashboard-event-schemas'
import type { MilestoneInstallCohort } from './telemetry-protected-milestone-schemas'

export type ChatUiLaunchTipTargeting =
  | { mode: 'all' }
  | { mode: 'eligible-harnesses'; eligible: boolean }
  | { mode: 'not-switched'; eligible: boolean }

export type ChatUiLaunchTipCohort =
  | 'control'
  | 'treatment'
  | 'treatment-live-switch'
  | 'treatment-swapped-buttons'
  | 'treatment-center'

export type TelemetrySettings = {
  /** New users: true at install. Existing users: null until they resolve the first-launch banner. */
  optedIn: boolean | null
  /** Anonymous UUID v4. Generated on first run. Stable across launches; not surfaced in the UI. */
  installId: string
  /** Cohort marker: true for pre-existing profiles (gates the opt-in banner), false for fresh installs. */
  existedBeforeTelemetryRelease: boolean
  /** Frozen 50/50 assignment for fresh installs; absent for profiles predating the experiment. */
  onboardingLanguageCohort?: 'control' | 'treatment'
  /** Historical 70% control / 30% assignment; never changed by delivery expansions. */
  chatUiLaunchTipCohort?: ChatUiLaunchTipCohort
  /** Frozen corner-card-v3 assignment: 3/7 treatment for old controls, 60% for new enrollees. */
  chatUiLaunchTipRolloutCohort?: 'control' | 'treatment'
  /** Treatment cards split equally by eligibility; frozen locally from settings, never usage history. */
  chatUiLaunchTipButtonEmphasis?: 'normal' | 'swapped'
  chatUiLaunchTipTargeting?: ChatUiLaunchTipTargeting
  /** Local UTC-day cursors cap dashboard observations across restarts; at most two writes a day. */
  agentDashboardActiveDays?: Partial<Record<AgentDashboardSurface, number>>
  /** UTC-day cursors written only after the SDK accepted the milestone capture; at most two writes a day. */
  protectedMilestones?: {
    installCohort?: MilestoneInstallCohort
    firstAgentInteractionDay?: number
    meaningfulActivityDay?: number
  }
}
