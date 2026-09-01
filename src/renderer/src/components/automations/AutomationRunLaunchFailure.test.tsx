// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AutomationRunLaunchFailure } from './AutomationRunLaunchFailure'
import type { PersistedAgentLaunchFailure } from '../../../../shared/agent-launch-contract'

function failure(
  overrides: Partial<PersistedAgentLaunchFailure> = {}
): PersistedAgentLaunchFailure {
  return {
    version: 1,
    failureId: 'failure-1',
    intent: 'automation',
    occurredAt: 1,
    code: 'launch_state_unknown',
    ...overrides
  }
}

afterEach(() => cleanup())

describe('AutomationRunLaunchFailure', () => {
  it('renders the automation-intent title and the client-safe code hint', () => {
    render(<AutomationRunLaunchFailure failure={failure()} forgottenAt={null} />)
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText("An automation's agent didn't start.")).toBeTruthy()
    expect(
      screen.getByText('The launch status is unknown. Check the terminal before retrying.')
    ).toBeTruthy()
  })

  it('maps each failure code to its own hint copy', () => {
    render(<AutomationRunLaunchFailure failure={failure({ code: 'custom_agent_disabled' })} forgottenAt={null} />)
    expect(
      screen.getByText('This agent is turned off. Enable it in Settings to launch it.')
    ).toBeTruthy()
  })

  it('omits the forgotten note until the run is explicitly forgotten', () => {
    render(<AutomationRunLaunchFailure failure={failure()} forgottenAt={null} />)
    expect(screen.queryByText("You forgot this launch, so it won't run again.")).toBeNull()
  })

  it('shows the forgotten note when the run was forgotten', () => {
    render(<AutomationRunLaunchFailure failure={failure()} forgottenAt={42} />)
    expect(screen.getByText("You forgot this launch, so it won't run again.")).toBeTruthy()
  })

  it('offers Forget only while the launch is provider-unknown', () => {
    const { rerender } = render(
      <AutomationRunLaunchFailure failure={failure()} forgottenAt={null} onForget={() => {}} />
    )
    expect(screen.getByRole('button', { name: /Forget launch/ })).toBeTruthy()
    // A non-unknown failure has a settled outcome, so there is nothing to forget.
    rerender(
      <AutomationRunLaunchFailure
        failure={failure({ code: 'spawn_failed' })}
        forgottenAt={null}
        onForget={() => {}}
      />
    )
    expect(screen.queryByRole('button', { name: /Forget launch/ })).toBeNull()
  })

  it('hides Forget once the run is already forgotten', () => {
    render(<AutomationRunLaunchFailure failure={failure()} forgottenAt={42} onForget={() => {}} />)
    expect(screen.queryByRole('button', { name: /Forget launch/ })).toBeNull()
  })

  it('never offers Retry (a forgotten automation run is never retried)', () => {
    render(<AutomationRunLaunchFailure failure={failure()} forgottenAt={null} onForget={() => {}} />)
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
  })

  it('invokes onForget when the Forget button is clicked', () => {
    let clicked = 0
    render(
      <AutomationRunLaunchFailure
        failure={failure()}
        forgottenAt={null}
        onForget={() => {
          clicked += 1
        }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Forget launch/ }))
    expect(clicked).toBe(1)
  })

  it('disables Forget while a forget is in flight', () => {
    render(
      <AutomationRunLaunchFailure failure={failure()} forgottenAt={null} onForget={() => {}} busy />
    )
    expect(screen.getByRole('button', { name: /Forget launch/ }).hasAttribute('disabled')).toBe(true)
  })
})
