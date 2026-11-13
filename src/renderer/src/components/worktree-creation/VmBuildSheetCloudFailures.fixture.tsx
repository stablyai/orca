import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  CLOUD_FAILED_LOG,
  CLOUD_LOG,
  CLOUD_RECIPE,
  entry,
  FAILED_LOG,
  LOG,
  frame,
  seedFixtureRepo,
  stubBillingRole,
  T0
} from './vm-build-sheet-fixture-support'

// Orca Cloud refusals and failures, one card each.

// An owner unless stated: the card's billing fix depends on the role billing reports.
function cloudFailure(
  errorCode: string | undefined,
  error: string,
  log = CLOUD_LOG,
  plan: Record<string, unknown> = {}
) {
  const fixture = frame(
    entry({ status: 'error', errorCode, provisioningLog: log, errorAt: T0 + 2_000 }, CLOUD_RECIPE),
    error,
    T0 + 2_000
  )
  return defineFixture({
    ...fixture,
    setup: () => {
      seedFixtureRepo()
      stubBillingRole(true, plan)
    }
  })
}

export const cloudPlanRequired = cloudFailure(
  'cloudPlanRequired',
  'Orca Cloud workspaces need a plan with cloud hours. Open Plan & billing to choose one.',
  ''
)

// EP-11: the plan blocker's body follows billing's reason; only a plan that existed has "ended".
export const cloudPlanRequiredNeverPaid = cloudFailure(
  'cloudPlanRequired',
  'Orca Cloud workspaces need a plan with cloud hours. Open Plan & billing to choose one.',
  '',
  { plan: null, status: 'none', reason: 'no_subscription' }
)

export const cloudPlanRequiredEnded = cloudFailure(
  'cloudPlanRequired',
  'Orca Cloud workspaces need a plan with cloud hours. Open Plan & billing to choose one.',
  '',
  { status: 'canceled', reason: 'subscription_inactive' }
)

export const cloudPlanRequiredTrialUsedUp = cloudFailure(
  'cloudPlanRequired',
  'Orca Cloud workspaces need a plan with cloud hours. Open Plan & billing to choose one.',
  '',
  { plan: null, status: 'trial', reason: 'trial_used_up' }
)

export const cloudPlanRequiredTrialUsedUpMember = defineFixture({
  ...cloudPlanRequiredTrialUsedUp,
  setup: () => {
    seedFixtureRepo()
    stubBillingRole(false, { plan: null, status: 'trial', reason: 'trial_used_up' })
  }
})

export const cloudPlanRequiredTrialUnavailable = cloudFailure(
  'cloudPlanRequired',
  'Orca Cloud workspaces need a plan with cloud hours. Open Plan & billing to choose one.',
  '',
  { plan: null, status: 'none', reason: 'trial_unavailable' }
)

export const cloudConcurrencyLimit = cloudFailure(
  'cloudConcurrencyLimit',
  'You already have as many Orca Cloud workspaces running as your plan allows.',
  ''
)

// A 4-seat Team: billing's caps are 12 running for the team, 3 per member.
export const cloudConcurrencyLimitTeam = cloudFailure(
  'cloudConcurrencyLimit',
  'You already have as many Orca Cloud workspaces running as your plan allows.',
  `${CLOUD_LOG}\nOrca Cloud: concurrency_limit`,
  {
    status: 'active',
    seats: 4,
    limits: { maxConcurrentSandboxes: 12, maxConcurrentSandboxesPerMember: 3 }
  }
)

// The one-time trial runs one sandbox at a time and has no seats.
export const cloudConcurrencyLimitTrial = cloudFailure(
  'cloudConcurrencyLimit',
  'You already have as many Orca Cloud workspaces running as your plan allows.',
  `${CLOUD_LOG}\nOrca Cloud: concurrency_limit`,
  {
    status: 'trial',
    seats: 0,
    trial: {
      includedSeconds: 7200,
      usedSeconds: 2160,
      remainingSeconds: 5040,
      exhausted: false,
      grantedAt: T0
    },
    limits: { maxConcurrentSandboxes: 1, maxConcurrentSandboxesPerMember: 1 }
  }
)

export const cloudUnavailable = cloudFailure(
  'cloudUnavailable',
  'Orca Cloud is unavailable right now. Try again in a moment.',
  ''
)

export const cloudSignInRequired = cloudFailure(
  'cloudSignInRequired',
  'Sign in to Orca to use Orca Cloud workspaces.',
  ''
)

export const cloudSnapshotMissing = cloudFailure(
  'recipeExited',
  'Recipe exited with code 1.',
  FAILED_LOG
)

export const cloudSpendCap = cloudFailure(
  'cloudPlanRequired',
  'Orca Cloud workspaces need a plan with cloud hours.',
  `${CLOUD_LOG}\nOrca Cloud: overage_cap_reached`
)

// A team member: billing is someone else's to change, so the card says who can.
function asMember(fixture: ReturnType<typeof cloudFailure>) {
  return defineFixture({
    ...fixture,
    setup: () => {
      seedFixtureRepo()
      stubBillingRole(false)
    }
  })
}

export const cloudHoursUsedMember = asMember(
  cloudFailure(
    'cloudPlanRequired',
    'Orca Cloud workspaces need a plan with cloud hours.',
    `${CLOUD_LOG}\nOrca Cloud: included_hours_exhausted`
  )
)

export const cloudSpendCapMember = asMember(
  cloudFailure(
    'cloudPlanRequired',
    'Orca Cloud workspaces need a plan with cloud hours.',
    `${CLOUD_LOG}\nOrca Cloud: overage_cap_reached`
  )
)

export const cloudPaymentFailedMember = asMember(
  cloudFailure(
    'cloudPlanRequired',
    'Orca Cloud workspaces need a plan with cloud hours.',
    `${CLOUD_LOG}\nOrca Cloud: payment_past_due`
  )
)

export const cloudPlanRequiredMember = asMember(
  cloudFailure(
    'cloudPlanRequired',
    'Orca Cloud workspaces need a plan with cloud hours. Open Plan & billing to choose one.',
    ''
  )
)

export const cloudMemberConcurrency = cloudFailure(
  'cloudConcurrencyLimit',
  'You already have as many Orca Cloud workspaces running as your plan allows.',
  `${CLOUD_LOG}\nOrca Cloud: member_concurrency_limit`
)

export const cloudGithubNotConnected = cloudFailure(
  'cloudGithubNotConnected',
  'Connect GitHub to your Orca account so Orca Cloud can clone this repository.',
  `${CLOUD_LOG}\nOrca Cloud: github_not_connected`
)

export const cloudGithubNotConnectedHttps = defineFixture({
  ...cloudGithubNotConnected,
  setup: () => seedFixtureRepo('https://github.com/nwparker/orca-sandbox-push-test.git')
})

// Refused on this computer before the control plane is asked: no sandbox, no charge.
export const cloudNoGithubRemote = defineFixture({
  ...cloudFailure(
    'cloudNoGithubRemote',
    'Orca Cloud clones your code from GitHub, and this repository has no GitHub remote.',
    ''
  ),
  setup: () => seedFixtureRepo(null)
})

export const cloudFailedLogsOpen = defineFixture({
  ...cloudFailure('cloudUnavailable', 'Orca Cloud is unavailable right now.', CLOUD_FAILED_LOG),
  interact: (frameElement) => {
    Array.from(frameElement.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('View logs'))
      ?.click()
  }
})

export const cloudFailed = cloudFailure(
  'recipeExited',
  'Recipe exited with code 1.',
  `${LOG}\nfatal: sandbox agent stopped unexpectedly`
)

export const cloudHoursUsed = cloudFailure(
  'cloudPlanRequired',
  'Orca Cloud workspaces need a plan with cloud hours.',
  `${CLOUD_LOG}\nOrca Cloud: included_hours_exhausted`
)

export const cloudPaymentDue = cloudFailure(
  'cloudPlanRequired',
  'Orca Cloud workspaces need a plan with cloud hours.',
  `${CLOUD_LOG}\nOrca Cloud: payment_past_due`
)

export const cloudNetwork = cloudFailure(undefined, 'fetch failed', CLOUD_LOG)

// JA-21: an owner fixing payment in the browser; the card waits with Check again.
export const cloudPaymentFinishInBrowser = defineFixture({
  ...cloudPaymentDue,
  setup: () => {
    cloudPaymentDue.setup?.()
    window.api.orcaProfiles.billingOpenPortal = () => Promise.resolve({ status: 'opened' })
  },
  interact: async (frameElement) => {
    Array.from(frameElement.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Update payment method')
      ?.click()
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
})
