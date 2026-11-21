// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHistoryScopeMenu } from './git-history-scope-menu'

afterEach(cleanup)

describe('GitHistoryScopeMenu', () => {
  it('defaults to all branches and allows choosing the current branch', async () => {
    const onChange = vi.fn()
    const view = render(<GitHistoryScopeMenu scope="all" onChange={onChange} />)
    const trigger = screen.getByRole('button', { name: 'History branches' })
    expect(trigger.textContent).toContain('All branches')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const allBranches = await screen.findByRole('menuitemradio', { name: 'All branches' })
    expect(allBranches.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Current branch' }))
    expect(onChange).toHaveBeenCalledWith('current')
    view.rerender(<GitHistoryScopeMenu scope="current" onChange={onChange} />)
    expect(screen.getByRole('button', { name: 'History branches' }).textContent).toContain(
      'Current branch'
    )
  })
})
