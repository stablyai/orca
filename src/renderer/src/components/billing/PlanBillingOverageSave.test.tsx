// @vitest-environment happy-dom
// OVERAGE-REENABLE: after Turn off the card showed "✓ Saving…" forever and no way to turn on again.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  OrcaBillingEntitlement,
  OrcaBillingOverageArgs
} from '../../../../shared/orca-billing'
import { OverageControls } from './PlanBillingUsage'
import { sampleTeam } from './plan-billing-fixtures'

afterEach(cleanup)

type Pending = { args: OrcaBillingOverageArgs; settle: (ok: boolean) => void }

/** Plays PlanBillingSection: busy while the request is out, then a re-read or a failure bump. */
function renderCard(initial: OrcaBillingEntitlement = sampleTeam): { pending: Pending[] } {
  const pending: Pending[] = []
  function Card(): React.JSX.Element {
    const [entitlement, setEntitlement] = useState(initial)
    const [busy, setBusy] = useState(false)
    const [failures, setFailures] = useState(0)
    return (
      <OverageControls
        entitlement={entitlement}
        busy={busy}
        failures={failures}
        onSetOverage={(args) => {
          setBusy(true)
          pending.push({
            args,
            settle: (ok) => {
              setBusy(false)
              if (!ok) {
                setFailures((count) => count + 1)
                return
              }
              // Billing keeps the cap through an opt-out; an omitted cap keeps the current one.
              setEntitlement((current) => ({
                ...current,
                overage: {
                  ...current.overage,
                  optedIn: args.enabled,
                  active: args.enabled,
                  spendCapCents: args.spendCapCents ?? current.overage.spendCapCents
                }
              }))
            }
          })
        }}
      />
    )
  }
  render(<Card />)
  return { pending }
}

const settleLast = (pending: Pending[], ok: boolean): void => {
  act(() => pending.at(-1)!.settle(ok))
}
const turnOnButton = (): HTMLElement =>
  screen.getByRole('button', { name: 'Turn on with a $25 cap' })
const statusText = (): string | null => screen.queryByRole('status')?.textContent ?? null

describe('overage on, off and on again', () => {
  it('turns on, off and on again with the same control, ending each change in Saved', () => {
    const { pending } = renderCard()
    fireEvent.click(turnOnButton())
    expect(pending.at(-1)!.args).toEqual({ enabled: true, spendCapCents: 2500 })
    expect(statusText()).toBe('Saving…')
    settleLast(pending, true)
    expect(screen.getByLabelText<HTMLInputElement>('Monthly spend cap').value).toBe('25')
    expect(statusText()).toBe('Saved')

    fireEvent.click(screen.getByRole('button', { name: 'Turn off overage' }))
    expect(pending.at(-1)!.args).toEqual({ enabled: false })
    expect(statusText()).toBe('Saving…')
    settleLast(pending, true)
    expect(screen.getByText(/^Overage is off\./)).toBeTruthy()
    // The bug: the off view kept a stale flag and showed "✓ Saving…" in place of Turn on.
    expect(statusText()).toBe('Saved')
    expect(turnOnButton().getAttribute('aria-disabled')).toBeNull()
    expect(document.activeElement).toBe(turnOnButton())

    fireEvent.click(turnOnButton())
    expect(pending).toHaveLength(3)
    expect(pending.at(-1)!.args).toEqual({ enabled: true, spendCapCents: 2500 })
    settleLast(pending, true)
    expect(screen.getByLabelText('Monthly spend cap')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByLabelText('Monthly spend cap'))
    expect(statusText()).toBe('Saved')
  })

  it('keeps Turn on visible but inert while saving, so one click sends one change', () => {
    const { pending } = renderCard()
    fireEvent.click(turnOnButton())
    expect(turnOnButton().getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(turnOnButton())
    expect(pending).toHaveLength(1)
  })

  it('a cap change goes Saving… then Saved, and editing again clears it', () => {
    const { pending } = renderCard({
      ...sampleTeam,
      overage: { ...sampleTeam.overage, optedIn: true, active: true, spendCapCents: 4000 }
    })
    const field = screen.getByLabelText<HTMLInputElement>('Monthly spend cap')
    fireEvent.change(field, { target: { value: '60' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(statusText()).toBe('Saving…')
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    settleLast(pending, true)
    expect(statusText()).toBe('Saved')
    expect(field.value).toBe('60')
    fireEvent.change(field, { target: { value: '70' } })
    expect(statusText()).toBeNull()
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
  })
})

describe('overage save state', () => {
  it('a failed Turn off ends in Couldn’t save and leaves overage on and changeable', () => {
    const { pending } = renderCard({
      ...sampleTeam,
      overage: { ...sampleTeam.overage, optedIn: true, active: true, spendCapCents: 4000 }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Turn off overage' }))
    settleLast(pending, false)
    expect(statusText()).toBe('Couldn’t save')
    expect(screen.getByLabelText<HTMLInputElement>('Monthly spend cap').value).toBe('40')
    const off = screen.getByRole('button', { name: 'Turn off overage' })
    expect(off.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(off)
    expect(pending).toHaveLength(2)
  })

  it('a failed Turn on ends in Couldn’t save next to a working Turn on', () => {
    const { pending } = renderCard()
    fireEvent.click(turnOnButton())
    settleLast(pending, false)
    expect(statusText()).toBe('Couldn’t save')
    expect(screen.queryByLabelText('Monthly spend cap')).toBeNull()
    fireEvent.click(turnOnButton())
    expect(pending).toHaveLength(2)
    settleLast(pending, true)
    expect(statusText()).toBe('Saved')
  })

  it('never shows the check with Saving…', () => {
    const { pending } = renderCard()
    fireEvent.click(turnOnButton())
    const saving = screen.getByRole('status')
    expect(saving.textContent).toBe('Saving…')
    expect(saving.querySelector('.lucide-check')).toBeNull()
    settleLast(pending, true)
    expect(screen.getByRole('status').querySelector('.lucide-check')).toBeTruthy()
  })

  // A host that never reports busy still resolves once the card reads the new state.
  it('resolves Saving… from the re-read when busy never changes', () => {
    const view = render(
      <OverageControls entitlement={sampleTeam} busy={false} onSetOverage={() => {}} />
    )
    fireEvent.click(turnOnButton())
    expect(statusText()).toBe('Saving…')
    view.rerender(
      <OverageControls
        entitlement={{
          ...sampleTeam,
          overage: { ...sampleTeam.overage, optedIn: true, active: true, spendCapCents: 2500 }
        }}
        busy={false}
        onSetOverage={() => {}}
      />
    )
    expect(statusText()).toBe('Saved')
  })
})
