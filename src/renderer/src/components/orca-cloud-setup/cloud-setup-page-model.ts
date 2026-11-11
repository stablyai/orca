// The full-page Orca Cloud setup (composer-redo): which step is current, what its one action is,
// and when the saved prompt can start. Pure, so every state is unit-tested here.
import type { CloudSetupStep } from '@/components/new-workspace/run-on/cloud-start-model'

/** What the current step's primary button does. */
export type CloudSetupPageAction =
  /** Sign in (and whatever the browser trip covers next): one browser hop. */
  | 'sign-in'
  /** The team's trial, claimed in the app: no browser, no card. */
  | 'start-trial'
  /** Stripe Checkout for a plan: one browser hop. */
  | 'choose-plan'
  /** Hours, spend cap or payment, fixed in billing settings or the portal. */
  | 'fix-billing'
  /** Personal account while a team has the plan: switch in place (B2). */
  | 'switch-team'
  /** Install the GitHub App on this repository: one browser hop. */
  | 'github-install'
  /** An owner must approve on GitHub; the page waits and starts on its own. */
  | 'github-waiting'
  /** The project isn't on GitHub; nothing here fixes it. */
  | 'needs-repository'
  /** A member can't fix billing; an owner or admin has to. */
  | 'ask-owner'
  /** Optional agent account: set it up once, or skip. */
  | 'agent'
  /** Still reading account, plan or repository state. */
  | 'checking'
  /** Every step is done: the prompt starts. */
  | 'done'

export type CloudSetupPageModel = {
  steps: readonly CloudSetupStep[]
  current: CloudSetupStep | null
  action: CloudSetupPageAction
}

function isFinished(step: CloudSetupStep, agentSkipped: boolean): boolean {
  if (step.state === 'done') {
    return true
  }
  if (step.id === 'agent') {
    // Still loading reads "Checking": the page only says All set once every row has answered.
    return agentSkipped && step.state !== 'loading'
  }
  return false
}

export function actionForStep(
  step: CloudSetupStep,
  { teamSwitch = false }: { teamSwitch?: boolean } = {}
): CloudSetupPageAction {
  if (step.state === 'loading') {
    return 'checking'
  }
  switch (step.id) {
    case 'account':
      return 'sign-in'
    case 'team':
      return teamSwitch ? 'switch-team' : 'sign-in'
    case 'plan':
      if (step.state === 'pending') {
        return 'sign-in'
      }
      if (step.canFix === false) {
        return 'ask-owner'
      }
      switch (step.need) {
        case 'trial':
          return 'start-trial'
        case 'hours':
        case 'spend-cap':
        case 'payment':
          return 'fix-billing'
        case 'plan':
        case 'renew-plan':
        case 'trial-used-up':
        case 'sign-in':
        case 'github':
        case undefined:
          return 'choose-plan'
      }
      return 'choose-plan'
    case 'github':
      if (step.state === 'failed' && step.blocksStart) {
        return 'needs-repository'
      }
      if (step.state === 'pending' && step.blocksStart) {
        return 'github-waiting'
      }
      return 'github-install'
    case 'agent':
      return 'agent'
  }
}

/**
 * The page's state from the setup rows. Steps come in walk order (account, team, plan, GitHub,
 * agent); the first unfinished one is current. A signed-out plan row is "pending" until sign-in, so
 * account stays current until then.
 */
export function cloudSetupPageModel(
  steps: readonly CloudSetupStep[],
  {
    agentSkipped = false,
    teamSwitch = false
  }: { agentSkipped?: boolean; teamSwitch?: boolean } = {}
): CloudSetupPageModel {
  const current = steps.find((step) => !isFinished(step, agentSkipped)) ?? null
  if (!current) {
    return { steps, current: null, action: 'done' }
  }
  return { steps, current, action: actionForStep(current, { teamSwitch }) }
}

/** Needs that a browser trip (setup session) can cover, from the current step on. */
export function sessionNeedsFrom(steps: readonly CloudSetupStep[]): CloudSetupStep['id'][] {
  return steps
    .filter((step) => step.state !== 'done' && step.state !== 'optional' && step.id !== 'agent')
    .map((step) => step.id)
}

/**
 * Pressing Start goes straight to create only when nothing is open. An agent without an account
 * counts until the user skips it once; a still-loading agent row never holds a start.
 */
export function cloudSetupRequired(
  steps: readonly CloudSetupStep[],
  {
    teamSwitch = false,
    agentSkipped = false
  }: { teamSwitch?: boolean; agentSkipped?: boolean } = {}
): boolean {
  if (teamSwitch) {
    return true
  }
  return steps.some((step) => {
    if (step.id === 'agent') {
      return step.state === 'optional' && !agentSkipped
    }
    return step.state !== 'done'
  })
}
