// @vitest-environment happy-dom
// JA-25 follow-up (Neil): the Run on menu's Orca Cloud row no longer shows "N sandbox hours left".
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { RUN_ON_SHOWS_HOURS_LEFT, RunTargetOrcaCloudRow } from './RunTargetOrcaCloudRow'
import type { OrcaCloudRunTargetAccess } from './orca-cloud-run-target-access'

afterEach(cleanup)

function row(access: OrcaCloudRunTargetAccess) {
  render(
    <TooltipProvider>
      <div role="listbox">
        <RunTargetOrcaCloudRow
          recipe={null}
          access={access}
          pending={false}
          armed={false}
          current={false}
          optionId="cloud"
          onArm={vi.fn()}
          onSelect={vi.fn()}
          onBlockedAction={vi.fn()}
        />
      </div>
    </TooltipProvider>
  )
  return screen.getByRole('option')
}

describe('Run on → Orca Cloud row', () => {
  it('is off by default', () => {
    expect(RUN_ON_SHOWS_HOURS_LEFT).toBe(false)
  })

  it('entitled (plan or trial): reads "Orca Cloud" / "Sandbox", no hours left', () => {
    const plan = row({ state: 'entitled', remainingSeconds: 41 * 3600 })
    expect(plan.textContent).toContain('Orca Cloud')
    expect(plan.textContent).toContain('Sandbox')
    expect(plan.textContent).not.toMatch(/hours? left/)
    cleanup()
    const trial = row({ state: 'entitled', remainingSeconds: 3 * 3600, trial: true })
    expect(trial.textContent).not.toMatch(/hours? left/)
  })

  it('loading: no placeholder where the hours were, only the screen-reader status', () => {
    const loading = row({ state: 'loading' })
    expect(loading.querySelector('[data-slot="skeleton"]')).toBeNull()
    expect(loading.textContent).toContain('Checking your plan…')
  })

  it('blocked states keep their reason and fix', () => {
    const out = row({ state: 'out-of-hours', cause: 'hours', canManageBilling: true })
    expect(out.textContent).toContain('Out of sandbox hours')
    expect(out.textContent).toContain('Turn on overage')
  })
})
