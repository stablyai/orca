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
