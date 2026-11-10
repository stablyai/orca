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
export type CloudSetupNeed =
  | 'sign-in'
  | 'plan'
  | 'renew-plan'
  | 'hours'
  | 'spend-cap'
  | 'payment'
  | 'github'
  /** The team can still get its one-time trial; setup grants it with no card (O7). */
  | 'trial'
  /** The team's trial hours are used up: a plan is next (T2). */
  | 'trial-used-up'
export type CloudSetupStep = {
  id: CloudSetupStepId
  state: CloudSetupStepState
  /** Which fix the row needs; drives copy and the primary label. */
  need?: CloudSetupNeed
  /** Owners/admins can fix plan, hours and payment; members can only ask. */
  canFix?: boolean
  /** Nothing in this composer fixes it (GitHub approval pending, no GitHub remote): ⌘↵ runs locally. */
  blocksStart?: boolean
  /** The trial on offer, from billing's offers.trial (never a literal). */
  trialSeconds?: number
  /** Session-provided specifics (account email, team name); shown in place of the generic line. */
  detail?: string
  /** Overrides for rows another module words (the GitHub row, the agent row). */
  label?: string
  status?: string
  /** Second line under the detail. */
  note?: string
  /** In-row button, e.g. D3 "How to push" or the agent row's "Set up once". */
  action?: { label: string; onClick: () => void }
}

/**
 * Rows derived from today's billing access and the build's availability, until the setup session
 * (N1) reports them itself. Done rows are kept so the panel can show progress; the panel hides when
 * every required row is done.
 */
export function deriveCloudSetupSteps({
  availability,
  access,
  github = null
}: {
  availability: OrcaCloudAvailability
  access: OrcaCloudRunTargetAccess
  /** The GitHub row from the repository-access check (D1–D3); null while it can't be known. */
  github?: CloudSetupStep | null
}): CloudSetupStep[] {
  const signedOut = availability === 'needs-sign-in' || access.state === 'signed-out'
  const account: CloudSetupStep = signedOut
    ? { id: 'account', state: 'needed', need: 'sign-in', canFix: true }
    : { id: 'account', state: 'done' }
  const plan = derivePlanStep(signedOut, availability, access)
  // D3: no GitHub remote outranks account and plan rows, because buying can't fix it.
  if (github?.blocksStart && github.state === 'failed') {
    return [github]
  }
  // The agent row never blocks a start; it is hidden while a member can't start at all (C1).
  const memberBlocked = plan.state === 'needed' && plan.canFix === false
  if (memberBlocked) {
    return [account, plan]
  }
  return [account, plan, ...(github ? [github] : []), { id: 'agent', state: 'optional' }]
}

function derivePlanStep(
  signedOut: boolean,
  availability: OrcaCloudAvailability,
  access: OrcaCloudRunTargetAccess
): CloudSetupStep {
  if (signedOut) {
    // A new account's team gets the trial in the same trip (A1); setup says if it can't.
    return { id: 'plan', state: 'pending', need: 'trial' }
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
      if (access.trialOfferSeconds) {
        // Anyone on the team can start its trial; no card, so members aren't blocked (B1).
        return {
          id: 'plan',
          state: 'needed',
          need: 'trial',
          canFix: true,
          trialSeconds: access.trialOfferSeconds
        }
      }
      return {
        id: 'plan',
        state: 'needed',
        need: access.trialUsedUp ? 'trial-used-up' : access.lapsed ? 'renew-plan' : 'plan',
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
  /** Only the trial is missing: setup grants it, so the button just says Start (B1). */
  | 'startTrial'
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
  if (
    open.some((step) => (step.state === 'needed' && step.canFix === false) || step.blocksStart)
  ) {
    return 'useThisComputer'
  }
  if (open.every((step) => step.state === 'loading')) {
    return 'checking'
  }
  const needed = open.filter((step) => step.state !== 'pending' && step.state !== 'loading')
  if (needed.length === 1) {
    const need = needed[0]?.need
    if (need === 'plan' || need === 'trial-used-up') {
      return 'choosePlanAndStart'
    }
    if (need === 'trial') {
      return 'startTrial'
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
