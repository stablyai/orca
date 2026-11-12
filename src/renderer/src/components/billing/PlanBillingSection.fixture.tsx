import { defineFixture } from '../../component-fixtures/component-fixture'
import { PlanBillingView } from './PlanBillingSection'
import {
  sampleTeam,
  sampleTrial,
  sampleTrialUsedUp,
  sampleUsageHistory,
  sampleUsageNames
} from './plan-billing-fixtures'

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

// JA-18: "<Team> · Team plan", the last 30 days with top workspaces and members, one cap field.
export const activeTeam = defineFixture({
  width: 680,
  render: () => (
    <PlanBillingView
      {...handlers}
      teamName="Orca Staging Eval Team"
      usage={usage}
      result={{ status: 'ok', entitlement: sampleTeam }}
    />
  )
})

// Billing sent no catalog (an older service or a failed read): "Turn on overage" with no amount,
// alert copy without levels. Billing applies its own default cap.
export const overageOffNoOffers = defineFixture({
  width: 680,
  render: () => (
    <PlanBillingView
      {...handlers}
      teamName="Orca Staging Eval Team"
      usage={usage}
      result={{ status: 'ok', entitlement: { ...sampleTeam, offers: null } }}
    />
  )
})

export const noPlan = defineFixture({
  width: 680,
  render: () => (
    <PlanBillingView
      {...handlers}
      result={{
        status: 'ok',
        entitlement: {
          ...sampleTeam,
          plan: null,
          planLabel: null,
          status: 'none',
          interval: null,
          seats: 0,
          period: null,
          usageWindow: null,
          includedSeconds: 0,
          usedSeconds: 0,
          remainingIncludedSeconds: 0,
          canStartSandbox: false,
          reason: 'no_subscription'
        }
      }}
    />
  )
})

export const overageCapReached = defineFixture({
  width: 600,
  render: () => (
    <PlanBillingView
      {...handlers}
      result={{
        status: 'ok',
        entitlement: {
          ...sampleTeam,
          interval: 'year',
          seats: 5,
          includedSeconds: 300 * HOUR,
          usedSeconds: 333 * HOUR,
          remainingIncludedSeconds: 0,
          usageWarningPercent: 100,
          overageSeconds: 33 * HOUR,
          overage: {
            optedIn: true,
            active: true,
            spendCapCents: 2500,
            spentCents: 2500,
            centsPerHour: 100
          },
          canStartSandbox: false,
          reason: 'overage_cap_reached'
        }
      }}
    />
  )
})

// Overage is off by default: out of included hours, running sandboxes go to sleep.
export const hoursUsedOverageOff = defineFixture({
  width: 600,
  render: () => (
    <PlanBillingView
      {...handlers}
      result={{
        status: 'ok',
        entitlement: {
          ...sampleTeam,
          usedSeconds: sampleTeam.includedSeconds,
          remainingIncludedSeconds: 0,
          usageWarningPercent: 100,
          canStartSandbox: false,
          reason: 'included_hours_exhausted'
        }
      }}
    />
  )
})

export const pastDueMember = defineFixture({
  width: 600,
  render: () => (
    <PlanBillingView
      {...handlers}
      result={{
        status: 'ok',
        entitlement: {
          ...sampleTeam,
          status: 'past_due',
          usedSeconds: 100 * HOUR,
          remainingIncludedSeconds: 20 * HOUR,
          usageWarningPercent: 80,
          payment: {
            pastDueSince: Date.UTC(2026, 10, 8, 9),
            graceEndsAt: Date.UTC(2026, 10, 12, 9),
            suspendRunning: false
          },
          canStartSandbox: false,
          reason: 'payment_past_due',
          canManageBilling: false
        }
      }}
    />
  )
})

export const suspendedAdmin = defineFixture({
  width: 600,
  render: () => (
    <PlanBillingView
      {...handlers}
      result={{
        status: 'ok',
        entitlement: {
          ...sampleTeam,
          status: 'past_due',
          payment: {
            pastDueSince: Date.UTC(2026, 10, 3, 9),
            graceEndsAt: Date.UTC(2026, 10, 7, 9),
            suspendRunning: true
          },
          canStartSandbox: false,
          reason: 'payment_grace_expired'
        }
      }}
    />
  )
})

/** First open of Settings › Orca Cloud › Plan & billing: the section holds its shape while billing answers. */
export const loading = defineFixture({
  width: 600,
  render: () => <PlanBillingView {...handlers} loading result={null} />
})

/** Billing's 75% level: the early warning under the bar (still the neutral tone below 90%). */
export const usageWarning75 = defineFixture({
  width: 600,
  render: () => (
    <PlanBillingView
      {...handlers}
      result={{
        status: 'ok',
        entitlement: {
          ...sampleTeam,
          usedSeconds: 92 * HOUR,
          remainingIncludedSeconds: 28 * HOUR,
          usageWarningPercent: 75
        }
      }}
    />
  )
})

/** Billing's 90% level: the bar turns to the warning tone; one hour left reads singular. */
export const usageWarning90 = defineFixture({
  width: 600,
  render: () => (
    <PlanBillingView
      {...handlers}
      result={{
        status: 'ok',
        entitlement: {
          ...sampleTeam,
          usedSeconds: 119 * HOUR,
          remainingIncludedSeconds: 1 * HOUR,
          usageWarningPercent: 90,
          overage: { ...sampleTeam.overage, optedIn: true, active: false }
        }
      }}
    />
  )
})

/** 100% with overage off: the alert says sandboxes sleep and points at overage (no repeat below). */
export const usageAlert100OverageOff = defineFixture({
  width: 600,
  render: () => (
    <PlanBillingView
      {...handlers}
      result={{
        status: 'ok',
        entitlement: {
          ...sampleTeam,
          usedSeconds: 120 * HOUR,
          remainingIncludedSeconds: 0,
          usageWarningPercent: 100,
          canStartSandbox: false,
          reason: 'included_hours_exhausted'
        }
      }}
    />
  )
})

/** 100% with overage on: the alert names the spend cap the team keeps going up to. */
export const usageAlert100OverageOn = defineFixture({
  width: 600,
  render: () => (
    <PlanBillingView
      {...handlers}
      result={{
        status: 'ok',
        entitlement: {
          ...sampleTeam,
          usedSeconds: 123 * HOUR,
          remainingIncludedSeconds: 0,
          overageSeconds: 3 * HOUR,
          usageWarningPercent: 100,
          overage: { ...sampleTeam.overage, optedIn: true, active: true, spentCents: 300 }
        }
      }}
    />
  )
})

/** A member at billing's 90% level: no admin usage notice (members aren't alerted). */
export const usageWarningMember = defineFixture({
  width: 600,
  render: () => (
    <PlanBillingView
      {...handlers}
      result={{
        status: 'ok',
        entitlement: {
          ...sampleTeam,
          usedSeconds: 109 * HOUR,
          remainingIncludedSeconds: 11 * HOUR,
          usageWarningPercent: 90,
          canManageBilling: false
        }
      }}
    />
  )
})

/** A member while overage is on: one line saying the cap, and what's been used. */
export const overageOnMember = defineFixture({
  width: 600,
  render: () => (
    <PlanBillingView
      {...handlers}
      result={{
        status: 'ok',
        entitlement: {
          ...sampleTeam,
          canManageBilling: false,
          overage: { ...sampleTeam.overage, optedIn: true, active: true, spentCents: 300 }
        }
      }}
    />
  )
})

/** Keyboard: "Turn off overage" reads as a link at rest and shows its focus ring. */
export const overageTurnOffFocused = defineFixture({
  ...usageAlert100OverageOn,
  interact: async (frame) => {
    const turnOff = [...frame.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Turn off overage'
    )
    turnOff?.focus()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
})

/** An admin types a cap above billing's maximum: the field says what the maximum is. */
export const capTooHigh = defineFixture({
  width: 600,
  render: () => (
    <PlanBillingView
      {...handlers}
      result={{
        status: 'ok',
        entitlement: {
          ...sampleTeam,
          overage: { ...sampleTeam.overage, optedIn: true, active: true, spentCents: 400 }
        }
      }}
    />
  ),
  interact: async (frame) => {
    const input = frame.querySelector<HTMLInputElement>('input[inputmode="numeric"]')
    if (!input) {
      return
    }
    input.focus()
    // React listens for native input events.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setValue?.call(input, '6000')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
})

/** Spec T1: the team's one-time trial, owner view (Choose plan). */
export const trial = defineFixture({
  width: 600,
  render: () => (
    <PlanBillingView {...handlers} result={{ status: 'ok', entitlement: sampleTrial }} />
  )
})

export const trialMember = defineFixture({
  width: 600,
  render: () => (
    <PlanBillingView
      {...handlers}
      result={{ status: 'ok', entitlement: { ...sampleTrial, canManageBilling: false } }}
    />
  )
})

export const trialUsedUp = defineFixture({
  width: 600,
  render: () => (
    <PlanBillingView {...handlers} result={{ status: 'ok', entitlement: sampleTrialUsedUp }} />
  )
})

export const trialUsedUpMember = defineFixture({
  width: 600,
  render: () => (
    <PlanBillingView
      {...handlers}
      result={{ status: 'ok', entitlement: { ...sampleTrialUsedUp, canManageBilling: false } }}
    />
  )
})

/** No plan and no trial on offer (this account or team already used one). */
export const trialUnavailable = defineFixture({
  width: 600,
  render: () => (
    <PlanBillingView
      {...handlers}
      result={{
        status: 'ok',
        entitlement: {
          ...sampleTrial,
          status: 'none',
          trial: null,
          includedSeconds: 0,
          usedSeconds: 0,
          remainingIncludedSeconds: 0,
          canStartSandbox: false,
          reason: 'trial_unavailable'
        }
      }}
    />
  )
})
