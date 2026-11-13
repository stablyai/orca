// @vitest-environment happy-dom
// CLOUD-CARD-RESTARTING-CLICK: while a restart runs, the card's "Restarting…" button is inert (and
// announced busy): a click never starts a second restart. Restart itself still works.

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudCardPrimaryAction } from './cloud-card-primary-action'
import type { CloudPanelActions } from './CloudWorkspaceStatusPanel'

afterEach(() => cleanup())

function renderRestart(restarting: boolean, anyBusy = false) {
  const onRestart = vi.fn()
  const actions: CloudPanelActions = { onRestart }
  const { getByRole } = render(
    <CloudCardPrimaryAction
      primary="restart"
      pending={undefined}
      restarting={restarting}
      anyBusy={anyBusy}
      actions={actions}
    />
  )
  return { onRestart, button: getByRole('button') }
}

describe('cloud card primary action: Restart', () => {
  it('restarts on click when no restart is running', () => {
    const { onRestart, button } = renderRestart(false)
    expect(button.textContent).toContain('Restart')
    fireEvent.click(button)
    expect(onRestart).toHaveBeenCalledTimes(1)
  })

  it('is inert while a restart runs, even one this card did not start (nothing else busy)', () => {
    const { onRestart, button } = renderRestart(true)
    expect(button.textContent).toContain('Restarting')
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.getAttribute('aria-busy')).toBe('true')
    fireEvent.click(button)
    fireEvent.click(button)
    expect(onRestart).not.toHaveBeenCalled()
  })
})
