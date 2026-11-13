// OVERAGE-REENABLE: the overage card through on → off → on, and each save state it can show.
import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type {
  OrcaBillingEntitlement,
  OrcaBillingOverageArgs
} from '../../../../shared/orca-billing'
import { PlanBillingView, type PlanBillingNotice } from './PlanBillingSection'
import { sampleTeam } from './plan-billing-fixtures'

type Outcome = 'ok' | 'failed' | 'pending'

const overageOn: OrcaBillingEntitlement = {
  ...sampleTeam,
  overage: { ...sampleTeam.overage, optedIn: true, active: true, spendCapCents: 4000 }
}

/** Plays PlanBillingSection with a fake billing: busy while out, then a re-read or a failure. */
function OverageCard({
  initial,
  outcome
}: {
  initial: OrcaBillingEntitlement
  outcome: Outcome
}): React.JSX.Element {
  const [entitlement, setEntitlement] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [failures, setFailures] = useState(0)
  const [notice, setNotice] = useState<PlanBillingNotice | null>(null)
  const setOverage = (args: OrcaBillingOverageArgs): void => {
    setBusy(true)
    setNotice(null)
    if (outcome === 'pending') {
      return
    }
    setTimeout(() => {
      setBusy(false)
      if (outcome === 'failed') {
        setNotice({ kind: 'error', text: 'Couldn’t reach billing. Try again.' })
        setFailures((count) => count + 1)
        return
      }
      setEntitlement((current) => ({
        ...current,
        overage: {
          ...current.overage,
          optedIn: args.enabled,
          active: args.enabled,
          spendCapCents: args.spendCapCents ?? current.overage.spendCapCents
        }
      }))
    }, 20)
  }
  return (
    <PlanBillingView
      loading={false}
      busy={busy}
      notice={notice}
      teamName="Orca Staging Eval Team"
      result={{ status: 'ok', entitlement }}
      overageFailures={failures}
      onRefresh={() => {}}
      onPortal={() => {}}
      onSetOverage={setOverage}
      onSeePlans={() => {}}
    />
  )
}

function clickButton(frame: HTMLElement, label: RegExp): void {
  const button = [...frame.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
    label.test(candidate.textContent ?? '')
  )
  button?.click()
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150))

/** Turned on, then off: the off line, a working "Turn on with a $25 cap" and "Saved". */
export const overageOffAfterOn = defineFixture({
  width: 680,
  render: () => <OverageCard initial={overageOn} outcome="ok" />,
  interact: async (frame) => {
    clickButton(frame, /^Turn off overage$/)
    await settle()
  }
})

/** In flight: a spinner with "Saving…" (no check), Turn on still there but inert. */
export const overageSaving = defineFixture({
  width: 680,
  render: () => <OverageCard initial={sampleTeam} outcome="pending" />,
  interact: async (frame) => {
    clickButton(frame, /^Turn on with a/)
    await settle()
  }
})

/** Turned on again from off: the $25 cap field, focused, with "✓ Saved". */
export const overageSavedOnAgain = defineFixture({
  width: 680,
  render: () => <OverageCard initial={sampleTeam} outcome="ok" />,
  interact: async (frame) => {
    clickButton(frame, /^Turn on with a/)
    await settle()
  }
})

/** Turn off failed: overage stays on at its cap, "Couldn’t save", and billing's reason below. */
export const overageSaveError = defineFixture({
  width: 680,
  render: () => <OverageCard initial={overageOn} outcome="failed" />,
  interact: async (frame) => {
    clickButton(frame, /^Turn off overage$/)
    await settle()
  }
})
