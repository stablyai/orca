// "Start in Orca Cloud": what the Run on control shows, which setup rows are missing, and what the
// composer's primary button says and does. Pure, so every state the spec draws is unit-tested here.
import type { OrcaCloudAvailability } from '../../../../../shared/orca-yaml-hook-types'
import type { OrcaCloudRunTargetAccess } from '../orca-cloud-run-target-access'

/** The three segments of Run on: this computer, Orca Cloud, and everything else behind "⋯". */
export type RunOnSegment = 'local' | 'orca-cloud' | 'other'

export function getRunOnSegment({
  orcaCloudSelected,
  otherRecipeSelected,
  selectedHostIsLocal
}: {
  orcaCloudSelected: boolean
  otherRecipeSelected: boolean
  /** Null when no host is committed (the picker's "Choose where to run" state). */
  selectedHostIsLocal: boolean | null
}): RunOnSegment | null {
  if (orcaCloudSelected) {
    return 'orca-cloud'
  }
  if (otherRecipeSelected || selectedHostIsLocal === false) {
    return 'other'
  }
  return selectedHostIsLocal === null ? null : 'local'
}

/**
 * How the Orca Cloud segment behaves. `hidden`: this build doesn't ship Orca Cloud.
 * `unreachable`: it does, but the account check failed (offline); the segment stays visible and
 * aria-disabled so a returning user doesn't think the feature vanished.
 */
export type OrcaCloudSegmentState = 'hidden' | 'unreachable' | 'enabled'

export function getOrcaCloudSegmentState(
  availability: OrcaCloudAvailability
): OrcaCloudSegmentState {
  switch (availability) {
    case 'unavailable':
      return 'hidden'
    case 'unreachable':
      return 'unreachable'
    case 'offered':
    case 'needs-sign-in':
    case 'needs-capability':
      return 'enabled'
  }
}

/** One row of the "Set up Orca Cloud" panel. Shape shared with the setup session (team-billing-ux). */
export type CloudSetupStepId = 'account' | 'team' | 'plan' | 'github' | 'agent'
export type CloudSetupStepState =
  | 'done'
  | 'needed'
  | 'active'
  | 'pending'
  | 'failed'
  | 'optional'
  | 'loading'
export type CloudSetupStep = {
  id: CloudSetupStepId
  state: CloudSetupStepState
  /** Which fix the row needs; drives copy and the primary label. */
  need?: 'sign-in' | 'plan' | 'renew-plan' | 'hours' | 'spend-cap' | 'payment' | 'github'
  /** Owners/admins can fix plan, hours and payment; members can only ask. */
  canFix?: boolean
  /** Session-provided specifics (account email, team name); shown in place of the generic line. */
  detail?: string
}

/**
 * Rows derived from today's billing access and the build's availability, until the setup session
 * (N1) reports them itself. Done rows are kept so the panel can show progress; the panel hides when
 * every required row is done.
 */
export function deriveCloudSetupSteps({
  availability,
  access
}: {
  availability: OrcaCloudAvailability
  access: OrcaCloudRunTargetAccess
}): CloudSetupStep[] {
  const signedOut = availability === 'needs-sign-in' || access.state === 'signed-out'
  const account: CloudSetupStep = signedOut
    ? { id: 'account', state: 'needed', need: 'sign-in', canFix: true }
    : { id: 'account', state: 'done' }
  const plan = derivePlanStep(signedOut, availability, access)
  // The agent row never blocks a start; it is hidden while a member can't start at all.
  const memberBlocked = plan.state === 'needed' && plan.canFix === false
  return memberBlocked ? [account, plan] : [account, plan, { id: 'agent', state: 'optional' }]
}

function derivePlanStep(
  signedOut: boolean,
  availability: OrcaCloudAvailability,
  access: OrcaCloudRunTargetAccess
): CloudSetupStep {
  if (signedOut) {
    // Nothing is known about the plan before sign-in; the one setup trip covers it if needed.
    return { id: 'plan', state: 'pending' }
  }
  if (availability === 'needs-capability' && access.state !== 'no-plan') {
    return { id: 'plan', state: 'needed', need: 'plan', canFix: true }
  }
  switch (access.state) {
    case 'loading':
      return { id: 'plan', state: 'loading' }
    case 'entitled':
    case 'unknown':
      // Unknown proceeds, as today: the build reports any billing refusal.
      return { id: 'plan', state: 'done' }
    case 'signed-out':
      return { id: 'plan', state: 'pending' }
    case 'no-plan':
      return {
        id: 'plan',
        state: 'needed',
        need: access.lapsed ? 'renew-plan' : 'plan',
        canFix: access.canManageBilling
      }
    case 'out-of-hours':
      return {
        id: 'plan',
        state: 'needed',
        need: access.cause === 'cap' ? 'spend-cap' : 'hours',
        canFix: access.canManageBilling
      }
    case 'payment-issue':
      return { id: 'plan', state: 'needed', need: 'payment', canFix: access.canManageBilling }
  }
}

/** Required rows still open; `optional` (agent) never counts. */
export function getOpenSetupSteps(steps: readonly CloudSetupStep[]): CloudSetupStep[] {
  return steps.filter((step) => step.state !== 'done' && step.state !== 'optional')
}

/** The panel shows while anything required is open (or still loading). */
export function isCloudSetupPanelVisible(steps: readonly CloudSetupStep[]): boolean {
  return getOpenSetupSteps(steps).length > 0
}

export type CloudPrimaryAction =
  | 'start'
  | 'setUpAndStart'
  | 'choosePlanAndStart'
  | 'renewAndStart'
  | 'giveAccessAndStart'
  | 'useThisComputer'
  | 'checking'

/**
 * The composer's primary action while Orca Cloud is selected. The label names where the work runs
 * (spec D10); a member who can't fix a block gets "Use this computer instead" so ⌘↵ always works.
 */
export function getCloudPrimaryAction(steps: readonly CloudSetupStep[]): CloudPrimaryAction {
  const open = getOpenSetupSteps(steps)
  if (open.length === 0) {
    return 'start'
  }
  if (open.some((step) => step.state === 'needed' && step.canFix === false)) {
    return 'useThisComputer'
  }
  if (open.every((step) => step.state === 'loading')) {
    return 'checking'
  }
  const needed = open.filter((step) => step.state !== 'pending' && step.state !== 'loading')
  if (needed.length === 1) {
    const need = needed[0]?.need
    if (need === 'plan') {
      return 'choosePlanAndStart'
    }
    if (need === 'renew-plan') {
      return 'renewAndStart'
    }
    if (need === 'github') {
      return 'giveAccessAndStart'
    }
  }
  return 'setUpAndStart'
}

export type RunOnPreference = 'last' | 'local' | 'orca-cloud'

/**
 * The target a new composer opens on: the project's "Default run on" setting, else its last
 * successful start target, else the global last choice, else this computer. A blocked Orca Cloud
 * is never preselected (spec D7); `cloudBlockedReason` lets the hint say why.
 */
export function resolveDefaultRunOn({
  preference,
  lastForRepo,
  globalLast,
  cloudUsable
}: {
  preference: RunOnPreference
  lastForRepo: 'local' | 'orca-cloud' | null
  globalLast: 'local' | 'orca-cloud' | null
  cloudUsable: boolean
}): { target: 'local' | 'orca-cloud'; cloudFellBack: boolean } {
  const wanted = preference === 'last' ? (lastForRepo ?? globalLast ?? 'local') : preference
  if (wanted === 'orca-cloud' && !cloudUsable) {
    return { target: 'local', cloudFellBack: true }
  }
  return { target: wanted, cloudFellBack: false }
}
