// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaBillingEntitlement } from '../../../../shared/orca-billing'
import { OverageControls } from './PlanBillingUsage'
import { PlanBillingUsageHistory } from './PlanBillingUsageHistory'
import { PlanBillingView } from './PlanBillingSection'
import { sampleTeam, sampleUsageHistory, sampleUsageNames } from './plan-billing-fixtures'
import { UsageHistoryChart } from './UsageHistoryChart'

afterEach(cleanup)

const overageOn: OrcaBillingEntitlement = {
  ...sampleTeam,
  overage: { ...sampleTeam.overage, optedIn: true, active: true, spendCapCents: 4000 }
}

function capField(): HTMLInputElement {
  const field = screen.getByLabelText('Monthly spend cap')
  if (!(field instanceof HTMLInputElement)) {
    throw new Error('the spend cap is not an input')
  }
  return field
}

describe('spend cap field', () => {
  // N-09: off is one status line and one action; no "$ 0" field (it read as "on, capped at nothing").
  it('shows off as a status line and one Turn on button, with no cap field', () => {
    const onSetOverage = vi.fn()
    render(<OverageControls entitlement={sampleTeam} busy={false} onSetOverage={onSetOverage} />)
    expect(screen.getByText('Overage is off. Running sandboxes go to sleep and new ones can’t start when your team runs out of sandbox hours.')).toBeTruthy()
    expect(screen.queryByLabelText('Monthly spend cap')).toBeNull()
    expect(screen.queryByText('$')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Turn on with a $25 cap' }))
    expect(onSetOverage).toHaveBeenCalledWith({ enabled: true, spendCapCents: 2500 })
  })

  it('on: saves a new cap, refuses $0, and turns off with its own button', () => {
    const onSetOverage = vi.fn()
    render(<OverageControls entitlement={overageOn} busy={false} onSetOverage={onSetOverage} />)
    expect(capField().value).toBe('40')
    fireEvent.change(capField(), { target: { value: '60' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSetOverage).toHaveBeenLastCalledWith({ enabled: true, spendCapCents: 6000 })
    cleanup()
    onSetOverage.mockClear()
    render(<OverageControls entitlement={overageOn} busy={false} onSetOverage={onSetOverage} />)
    fireEvent.change(capField(), { target: { value: '0' } })
    expect(screen.getByText('Set a spend cap above $0, or turn overage off.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(onSetOverage).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Turn off overage' }))
    expect(onSetOverage).toHaveBeenLastCalledWith({ enabled: false })
  })

  it('puts the rate in one hint, shows spend as "of … used" and keeps the alert sentence', () => {
    render(<OverageControls entitlement={overageOn} busy={false} onSetOverage={() => {}} />)
    expect(capField().getAttribute('aria-describedby')).toBeTruthy()
    expect(
      screen.getByText('$1.00 per sandbox hour after your included hours, billed by the minute.')
    ).toBeTruthy()
    expect(screen.getByText(/of \$40 used/)).toBeTruthy()
    expect(screen.getByText(/alerted in Orca at 75%, 90% and 100%/)).toBeTruthy()
  })

  it('shows members the setting as text', () => {
    render(
      <OverageControls
        entitlement={{ ...overageOn, canManageBilling: false }}
        busy={false}
        onSetOverage={() => {}}
      />
    )
    expect(screen.queryByLabelText('Monthly spend cap')).toBeNull()
    expect(
      screen.getByText('Overage is on, up to your $40 spend cap.')
    ).toBeTruthy()
    expect(screen.queryByText(/alerted in Orca/)).toBeNull()
  })
})

describe('last 30 days', () => {
  it('reads each day with the arrow keys and lists every day in a table', () => {
    render(<UsageHistoryChart days={sampleUsageHistory.days} />)
    const chart = screen.getByRole('group')
    fireEvent.focus(chart)
    expect(screen.getByRole('status').textContent).toMatch(/· 0\.6 sandbox hours$/)
    fireEvent.keyDown(chart, { key: 'ArrowLeft' })
    expect(screen.getByRole('status').textContent).toMatch(/· 1\.5 sandbox hours$/)
    fireEvent.keyDown(chart, { key: 'Home' })
    expect(screen.getByRole('status').textContent).toMatch(/· 0\.5 sandbox hours$/)
    expect(screen.getAllByRole('row')).toHaveLength(30)
  })

  it('shows owners the top workspaces and members, and members only their share', () => {
    render(
      <PlanBillingUsageHistory
        state={{ status: 'ok', history: sampleUsageHistory, names: sampleUsageNames }}
        onRetry={() => {}}
      />
    )
    expect(screen.getByText('Top workspaces')).toBeTruthy()
    expect(screen.getByText('Checkout retries')).toBeTruthy()
    expect(screen.getByText('48 sandbox hours in 30 days')).toBeTruthy()
    cleanup()
    render(
      <PlanBillingUsageHistory
        state={{
          status: 'ok',
          history: { ...sampleUsageHistory, members: null, sandboxes: null },
          names: sampleUsageNames
        }}
        onRetry={() => {}}
      />
    )
    expect(screen.queryByText('Top workspaces')).toBeNull()
    expect(screen.getByText('You used 18.4 of your team’s 48 sandbox hours.')).toBeTruthy()
  })

  it('has empty, loading and error states', () => {
    const onRetry = vi.fn()
    render(<PlanBillingUsageHistory state={{ status: 'failed' }} onRetry={onRetry} />)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalled()
    cleanup()
    render(<PlanBillingUsageHistory state={{ status: 'loading' }} onRetry={onRetry} />)
    expect(screen.getByRole('status', { name: 'Loading your usage history…' })).toBeTruthy()
    cleanup()
    const empty = {
      ...sampleUsageHistory,
      days: sampleUsageHistory.days.map((day) => ({ ...day, seconds: 0 })),
      totalSeconds: 0
    }
    render(
      <PlanBillingUsageHistory
        state={{ status: 'ok', history: empty, names: sampleUsageNames }}
        onRetry={onRetry}
      />
    )
    expect(screen.getByText(/No sandbox hours yet/)).toBeTruthy()
    expect(screen.queryByRole('group')).toBeNull()
  })
})

describe('plan header', () => {
  it('titles the page "<Team> · Team plan" with no refresh button', () => {
    render(
      <PlanBillingView
        result={{ status: 'ok', entitlement: sampleTeam }}
        loading={false}
        busy={false}
        notice={null}
        teamName="Orca Staging Eval Team"
        onRefresh={() => {}}
        onPortal={() => {}}
        onSetOverage={() => {}}
        onSeePlans={() => {}}
      />
    )
    expect(screen.getByRole('heading', { name: 'Orca Staging Eval Team · Team plan' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Refresh plan' })).toBeNull()
  })
})

it('gives members an outlined Compare plans and the off line', () => {
  render(
    <PlanBillingView
      result={{ status: 'ok', entitlement: { ...sampleTeam, canManageBilling: false } }}
      loading={false}
      busy={false}
      notice={null}
      onRefresh={() => {}}
      onPortal={() => {}}
      onSetOverage={() => {}}
      onSeePlans={() => {}}
    />
  )
  expect(
    screen.getByText(
      'Off until an owner or admin turns it on.'
    )
  ).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Compare plans' }).className).toMatch(/border/)
})
