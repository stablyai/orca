// GH-CREATE-SHEET: Orca Cloud from a GitHub repository with no clone here uses the same build sheet.
// The logs are the lines main streams for it (cloud-create-from-github.ts), so the steps and the
// billing cards come from the same parsing and classification as an owned create's.
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import { githubCreateRequest } from '@/lib/orca-cloud/start-cloud-workspace-from-github'
import { sheet, stampsFor, stubBillingRole, T0 } from './vm-build-sheet-fixture-support'

const REQUEST = githubCreateRequest({
  repoUrl: 'https://github.com/nwparker/orca-sandbox-push-test',
  fullName: 'nwparker/orca-sandbox-push-test',
  prompt: 'Add a push test',
  agent: 'claude',
  composerRepoId: 'repo'
})

const STARTING = ['[orca-cloud] provisioning', '[orca-cloud] plan-clone']
const CLONING = [...STARTING, '[orca-cloud] cloning', '[orca-cloud] clone-progress 42 download']
const CLONED = [...CLONING, '[orca-cloud] clone-progress 100 checkout', '[orca-cloud] connecting']

function github(lines: readonly string[], patch: Partial<PendingWorktreeCreation> = {}) {
  const log = lines.join('\n')
  // One line every ~1.3 s from T0 (stampsFor), so the clone starts a few seconds in.
  return {
    creationId: 'fixture',
    phase: 'provisioning-vm' as const,
    status: 'creating' as const,
    startedAt: T0,
    indeterminate: false,
    loaderVisible: true,
    provisioningLog: log,
    provisioningLogStamps: stampsFor(lines.length),
    phaseLog: [{ phase: 'provisioning-vm' as const, at: T0 }],
    request: REQUEST,
    ...patch
  }
}

function fixture(
  value: PendingWorktreeCreation,
  now: number,
  {
    error = null,
    canManageBilling = true
  }: { error?: string | null; canManageBilling?: boolean } = {}
) {
  return defineFixture({
    width: 760,
    setup: () => stubBillingRole(canManageBilling),
    render: () => sheet(value, error, now)
  })
}

export const starting = fixture(github(STARTING), T0 + 2_500)

export const cloning = fixture(github(CLONING), T0 + 9_000)

export const opening = fixture(
  github(CLONED, {
    phase: 'creating',
    phaseLog: [
      { phase: 'provisioning-vm', at: T0 },
      { phase: 'creating', at: T0 + 7_000 }
    ]
  }),
  T0 + 8_000
)

export const openFailed = fixture(
  github(CLONED, {
    phase: 'creating',
    status: 'error',
    errorAt: T0 + 12_000,
    phaseLog: [
      { phase: 'provisioning-vm', at: T0 },
      { phase: 'creating', at: T0 + 7_000 }
    ]
  }),
  T0 + 12_000,
  {
    error:
      'Your cloud workspace started, but this computer couldn’t open it yet. Open it from Cloud workspaces.'
  }
)

// Billing refusals: main logs the control plane's reason line and returns cloudPlanRequired.
function refused(reason: string, canManageBilling = true) {
  return fixture(
    github(['[orca-cloud] provisioning', `Orca Cloud: ${reason}`], {
      status: 'error',
      errorCode: 'cloudPlanRequired',
      errorAt: T0 + 2_000
    }),
    T0 + 2_000,
    { error: 'Orca Cloud workspaces need a plan with cloud hours.', canManageBilling }
  )
}

export const refusedPlan = refused('no_subscription')
export const refusedHoursUsed = refused('included_hours_exhausted')
export const refusedSpendCap = refused('overage_cap_reached')
export const refusedPayment = refused('payment_past_due')
// A member can't fix billing: the card names who can, with no "Compare plans".
export const refusedPlanMember = refused('no_subscription', false)
export const refusedHoursUsedMember = refused('included_hours_exhausted', false)
