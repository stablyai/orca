// Orca Cloud from the composer: whether its Run on option is offered, which setup rows are missing,
// and the remembered default. Pure, so every state the spec draws is unit-tested here.
import type { OrcaCloudAvailability } from '../../../../../shared/orca-yaml-hook-types'
import type { OrcaCloudRunTargetAccess } from '../orca-cloud-run-target-access'

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

/** One step of the Orca Cloud setup page. Shape shared with the setup session (team-billing-ux). */
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
      // JA-21 (Neil): billing is progressive. A plan, hours, cap or payment problem isn't a setup
      // step; Create goes ahead and the creating sheet shows the blocker with its fix.
      return { id: 'plan', state: 'done' }
    case 'out-of-hours':
    case 'payment-issue':
      return { id: 'plan', state: 'done' }
  }
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

/**
 * The session's rows, with its GitHub row done once this desktop's own check reaches the
 * repository: the control plane's notice to the session is best effort, and the desktop's
 * repo-access poll is the fallback that keeps a waiting start from hanging.
 */
export function withReachableGitHub(
  steps: readonly CloudSetupStep[],
  reachable: boolean
): readonly CloudSetupStep[] {
  if (!reachable || !steps.some((step) => step.id === 'github' && step.state !== 'done')) {
    return steps
  }
  return steps.map((step): CloudSetupStep =>
    step.id === 'github' ? { id: 'github', state: 'done' } : step
  )
}
