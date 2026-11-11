// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentAccountsJumpRow } from './AgentAccountsJumpRow'
import { AgentAccountsSubsection } from './AgentAccountsSubsection'

const originalScrollIntoView = Element.prototype.scrollIntoView
afterEach(() => {
  cleanup()
  Element.prototype.scrollIntoView = originalScrollIntoView
})

describe('AgentAccountsJumpRow', () => {
  it('stays hidden when the page has only one part', () => {
    render(<AgentAccountsJumpRow links={[{ id: 'accounts-this-host', title: 'This computer' }]} />)
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('links every part in order and moves focus to the chosen heading', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    render(
      <>
        <AgentAccountsJumpRow
          links={[
            { id: 'accounts-this-host', title: 'This computer' },
            { id: 'accounts-hosts', title: 'Hosts' }
          ]}
        />
        <AgentAccountsSubsection id="accounts-this-host" title="This computer">
          <p>local</p>
        </AgentAccountsSubsection>
        <AgentAccountsSubsection id="accounts-hosts" title="Hosts">
          <p>hosts</p>
        </AgentAccountsSubsection>
      </>
    )
    const links = screen.getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(['This computer', 'Hosts'])
    fireEvent.click(screen.getByRole('link', { name: 'Hosts' }))
    expect(scrollIntoView).toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Hosts' }))
  })
})
