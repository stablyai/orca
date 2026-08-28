// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AutomationHostLabel, AutomationHostStatusBadges } from './AutomationHostBadges'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function entry(overrides: Partial<AutomationHostCatalogEntry> = {}): AutomationHostCatalogEntry {
  return {
    stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId: 't1' } },
    owner: null,
    stableKey: 'host:desktop:ssh:t1',
    label: 'web-01',
    authorityLabel: 'This computer',
    kind: 'ssh',
    catalogState: 'authoritative',
    authorityHealth: 'fresh',
    executionHealth: 'connected',
    querySupport: 'scoped',
    ...overrides
  }
}

function render(node: React.ReactNode): void {
  act(() => {
    root.render(<TooltipProvider>{node}</TooltipProvider>)
  })
}

function statusIds(axis?: string): string[] {
  const selector = axis ? `[data-status-axis="${axis}"]` : '[data-status-id]'
  return [...container.querySelectorAll(selector)].map(
    (node) => node.getAttribute('data-status-id') ?? ''
  )
}

describe('AutomationHostStatusBadges', () => {
  it('renders nothing when both axes rest healthy and the contract is scoped', () => {
    render(<AutomationHostStatusBadges entry={entry()} />)
    expect(statusIds()).toEqual([])
  })

  it('renders the two health axes as separate badges', () => {
    render(
      <AutomationHostStatusBadges
        entry={entry({ authorityHealth: 'stale-error', executionHealth: 'disconnected' })}
      />
    )
    expect(statusIds('authority')).toEqual(['authority-stale-error'])
    expect(statusIds('execution')).toEqual(['execution-disconnected'])
  })

  it('shows an execution failure while the authority is fresh', () => {
    render(<AutomationHostStatusBadges entry={entry({ executionHealth: 'disconnected' })} />)
    expect(statusIds('authority')).toEqual([])
    expect(statusIds('execution')).toEqual(['execution-disconnected'])
  })

  it('shows an authority failure while the target is connected', () => {
    render(<AutomationHostStatusBadges entry={entry({ authorityHealth: 'unavailable' })} />)
    expect(statusIds('authority')).toEqual(['authority-unavailable'])
    expect(statusIds('execution')).toEqual([])
  })

  it('distinguishes an incompatible authority from a legacy-unscoped contract', () => {
    render(<AutomationHostStatusBadges entry={entry({ authorityHealth: 'incompatible' })} />)
    const incompatible = statusIds()
    render(<AutomationHostStatusBadges entry={entry({ querySupport: 'legacy-unscoped' })} />)
    const legacy = statusIds()

    expect(incompatible).toContain('authority-incompatible')
    expect(legacy).toContain('query-legacy-unscoped')
    expect(incompatible).not.toEqual(legacy)
  })

  it('separates the incompatible query contract from the incompatible authority', () => {
    render(<AutomationHostStatusBadges entry={entry({ querySupport: 'incompatible' })} />)
    expect(statusIds('query')).toEqual(['query-incompatible'])
    expect(statusIds('authority')).toEqual([])
  })

  it('names the removed host, not the server, for a ghost entry', () => {
    render(
      <AutomationHostStatusBadges
        entry={entry({
          catalogState: 'removed',
          executionHealth: 'unavailable',
          querySupport: 'legacy-unscoped',
          scopeGap: 'target-removed'
        })}
      />
    )
    expect(statusIds('query')).toEqual(['query-target-removed'])
    expect(
      container.querySelector('[data-status-id="query-target-removed"]')?.getAttribute('aria-label')
    ).toBe(
      'View only. This host was removed, so its automations can no longer be edited or run from here.'
    )
  })

  it('separates an unverified target from a server that lacks host scoping', () => {
    render(
      <AutomationHostStatusBadges
        entry={entry({
          catalogState: 'unhydrated',
          executionHealth: 'unknown',
          querySupport: 'legacy-unscoped',
          scopeGap: 'target-unverified'
        })}
      />
    )
    expect(statusIds('query')).toEqual(['query-target-unverified'])
    expect(
      container
        .querySelector('[data-status-id="query-target-unverified"]')
        ?.getAttribute('aria-label')
    ).toBe(
      'View only. This host has not been verified since its connection dropped, so its automations cannot be edited or run from here.'
    )
  })

  it('names both the label and the explanation in the accessible name', () => {
    render(<AutomationHostStatusBadges entry={entry({ executionHealth: 'disconnected' })} />)
    const badge = container.querySelector('[data-status-id="execution-disconnected"]')
    expect(badge?.getAttribute('aria-label')).toBe(
      'Not connected. Automations on this host cannot run until the connection is restored.'
    )
  })

  it('renders resting states when asked to show healthy', () => {
    render(<AutomationHostStatusBadges entry={entry()} showHealthy />)
    expect(statusIds()).toEqual(['authority-fresh', 'execution-connected'])
  })
})

describe('AutomationHostLabel', () => {
  it('keeps the full name in the accessible name while the visible label truncates', () => {
    render(<AutomationHostLabel entry={entry({ label: 'a-very-long-host-name-that-truncates' })} />)
    const labelled = container.querySelector('[data-host-stable-key]')
    expect(labelled?.getAttribute('aria-label')).toBe('a-very-long-host-name-that-truncates')
    expect(container.querySelector('.truncate')?.textContent).toBe(
      'a-very-long-host-name-that-truncates'
    )
  })

  it('qualifies the accessible name with the authority when asked', () => {
    render(<AutomationHostLabel entry={entry()} showAuthority />)
    expect(container.querySelector('[data-host-stable-key]')?.getAttribute('aria-label')).toBe(
      'This computer · web-01'
    )
  })
})
