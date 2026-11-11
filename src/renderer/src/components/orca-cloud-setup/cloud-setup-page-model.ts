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
  /** Still reading account, plan or repository state. */
  | 'checking'
  /** Every step is done: the prompt starts. */
  | 'done'

export type CloudSetupPageModel = {
  steps: readonly CloudSetupStep[]
  current: CloudSetupStep | null
  action: CloudSetupPageAction
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
      // Never a page step (PC-1): agent sign-in is offered after create.
      return 'done'
  }
}

/**
 * The page's state from the setup rows. Steps come in walk order (account, team, plan, GitHub); the
 * first unfinished one is current. The agent row is never a step (PC-1): it never gates a start, and
 * its sign-in is offered after create. A signed-out plan row is "pending" until sign-in, so account
 * stays current until then.
 */
export function cloudSetupPageModel(
  rows: readonly CloudSetupStep[],
  { teamSwitch = false }: { teamSwitch?: boolean } = {}
): CloudSetupPageModel {
  const steps = rows.filter((step) => step.id !== 'agent')
  const current = steps.find((step) => step.state !== 'done') ?? null
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
 * Pressing Start opens the setup page only when the account, team, plan or GitHub is missing. The
 * agent never holds a start (PC-1): without an Orca Cloud account it starts as a plain terminal and
 * the post-create prompt offers the sign-in.
 */
export function cloudSetupRequired(
  steps: readonly CloudSetupStep[],
  { teamSwitch = false }: { teamSwitch?: boolean } = {}
): boolean {
  if (teamSwitch) {
    return true
  }
  return steps.some((step) => step.id !== 'agent' && step.state !== 'done')
}
