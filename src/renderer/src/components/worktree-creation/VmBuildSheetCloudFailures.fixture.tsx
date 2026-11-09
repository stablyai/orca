import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  CLOUD_FAILED_LOG,
  CLOUD_LOG,
  CLOUD_RECIPE,
  entry,
  FAILED_LOG,
  LOG,
  frame,
  T0
} from './vm-build-sheet-fixture-support'

// Orca Cloud refusals and failures, one card each.

function cloudFailure(errorCode: string | undefined, error: string, log = CLOUD_LOG) {
  return frame(
    entry({ status: 'error', errorCode, provisioningLog: log, errorAt: T0 + 2_000 }, CLOUD_RECIPE),
    error,
    T0 + 2_000
  )
}

export const cloudPlanRequired = cloudFailure(
  'cloudPlanRequired',
  'Orca Cloud workspaces need a plan with cloud hours. Open Plan & billing to choose one.',
  ''
)

export const cloudConcurrencyLimit = cloudFailure(
  'cloudConcurrencyLimit',
  'You already have as many Orca Cloud workspaces running as your plan allows.',
  ''
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

export const cloudHoursUsedMember = defineFixture({
  ...cloudFailure(
    'cloudPlanRequired',
    'Orca Cloud workspaces need a plan with cloud hours.',
    `${CLOUD_LOG}\nOrca Cloud: included_hours_exhausted`
  ),
  setup: () => {
    // A team member: billing is someone else's to change.
    window.api.orcaProfiles.billingStatus = () =>
      Promise.resolve({
        status: 'ok',
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the card reads only canManageBilling.
        entitlement: { canManageBilling: false } as never
      })
  }
})

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
