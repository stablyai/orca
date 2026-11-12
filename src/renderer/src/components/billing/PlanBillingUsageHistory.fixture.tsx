import { defineFixture } from '../../component-fixtures/component-fixture'
import { PlanBillingView } from './PlanBillingSection'
import { sampleTeam, sampleUsageHistory, sampleUsageNames } from './plan-billing-fixtures'

// JA-18 states of Plan & billing's "Last 30 days" and spend cap (activeTeam lives with the page).
const HOUR = 3600

const handlers = {
  loading: false,
  busy: false,
  notice: null,
  onRefresh: () => {},
  onPortal: () => {},
  onSetOverage: () => {},
  onSeePlans: () => {}
}

const usage = { status: 'ok', history: sampleUsageHistory, names: sampleUsageNames } as const

export const activeTeamOverageOn = defineFixture({
  width: 680,
  render: () => (
    <PlanBillingView
      {...handlers}
      teamName="Orca Staging Eval Team"
      usage={usage}
      result={{
        status: 'ok',
        entitlement: {
          ...sampleTeam,
          overage: { ...sampleTeam.overage, optedIn: true, active: true, spentCents: 320 }
        }
      }}
    />
  )
})

// Members see the team's chart and their own hours, not who used what.
export const activeTeamMember = defineFixture({
  width: 680,
  render: () => (
    <PlanBillingView
      {...handlers}
      teamName="Orca Staging Eval Team"
      usage={{
        ...usage,
        history: { ...sampleUsageHistory, members: null, sandboxes: null }
      }}
      result={{ status: 'ok', entitlement: { ...sampleTeam, canManageBilling: false } }}
    />
  )
})

export const usageLoading = defineFixture({
  width: 680,
  render: () => (
    <PlanBillingView
      {...handlers}
      teamName="Orca Staging Eval Team"
      usage={{ status: 'loading' }}
      result={{ status: 'ok', entitlement: sampleTeam }}
    />
  )
})

export const usageEmpty = defineFixture({
  width: 680,
  render: () => (
    <PlanBillingView
      {...handlers}
      teamName="Orca Staging Eval Team"
      usage={{
        ...usage,
        history: {
          ...sampleUsageHistory,
          days: sampleUsageHistory.days.map((day) => ({ ...day, seconds: 0 })),
          totalSeconds: 0,
          yourSeconds: 0,
          members: { top: [], otherCount: 0, otherSeconds: 0 },
          sandboxes: { top: [], otherCount: 0, otherSeconds: 0 }
        }
      }}
      result={{
        status: 'ok',
        entitlement: { ...sampleTeam, usedSeconds: 0, remainingIncludedSeconds: 120 * HOUR }
      }}
    />
  )
})

export const usageFailed = defineFixture({
  width: 680,
  render: () => (
    <PlanBillingView
      {...handlers}
      teamName="Orca Staging Eval Team"
      usage={{ status: 'failed' }}
      result={{ status: 'ok', entitlement: sampleTeam }}
    />
  )
})

// V3-06: a staging-like team: a few live workspaces among hundreds of short-lived, deleted ones.
// Up to 5 live ones by name, then one deleted line, then the other live ones.
const stagingLike = {
  ...sampleUsageHistory,
  totalSeconds: 34.6 * HOUR,
  sandboxes: {
    top: [
      { id: 'sbx_gone_1', seconds: 1.2 * HOUR },
      { id: 'sbx_orca', seconds: 0.9 * HOUR },
      { id: 'sbx_gone_2', seconds: 0.8 * HOUR },
      { id: 'sbx_hello', seconds: 0.6 * HOUR },
      { id: 'sbx_push', seconds: 0.5 * HOUR },
      { id: 'sbx_ja3', seconds: 0.4 * HOUR },
      { id: 'sbx_ikzw', seconds: 0.35 * HOUR },
      { id: 'sbx_gone_3', seconds: 0.3 * HOUR },
      { id: 'sbx_w312', seconds: 0.3 * HOUR }
    ],
    otherCount: 578,
    otherSeconds: 29.75 * HOUR
  }
}
const stagingNames = {
  ...sampleUsageNames,
  workspaces: new Map([
    ['sbx_orca', 'orca'],
    ['sbx_hello', 'Hello-World · ik-sheet'],
    ['sbx_push', 'orca-sandbox-push-test'],
    ['sbx_ja3', 'ja3-claude'],
    ['sbx_ikzw', 'ik-zw'],
    ['sbx_w312', 'W-312']
  ])
}
export const usageStagingLike = defineFixture({
  width: 680,
  render: () => (
    <PlanBillingView
      {...handlers}
      teamName="Orca Staging Eval Team"
      usage={{ status: 'ok', history: stagingLike, names: stagingNames }}
      result={{ status: 'ok', entitlement: sampleTeam }}
    />
  )
})

// V3-06: a small team: every live workspace by name, nothing summed.
export const usageSmallTeam = defineFixture({
  width: 680,
  render: () => (
    <PlanBillingView
      {...handlers}
      teamName="Acme"
      usage={{
        status: 'ok',
        history: {
          ...sampleUsageHistory,
          totalSeconds: 26 * HOUR,
          sandboxes: {
            top: [
              { id: 'sbx_checkout', seconds: 11 * HOUR },
              { id: 'sbx_ledger', seconds: 8 * HOUR },
              { id: 'sbx_docs', seconds: 5 * HOUR },
              { id: 'sbx_flaky', seconds: 2 * HOUR }
            ],
            otherCount: 0,
            otherSeconds: 0
          }
        },
        names: sampleUsageNames
      }}
      result={{ status: 'ok', entitlement: sampleTeam }}
    />
  )
})
