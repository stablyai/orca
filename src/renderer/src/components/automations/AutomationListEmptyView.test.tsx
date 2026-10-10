// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AutomationListEmptyView,
  type AutomationListEmptyViewProps
} from './AutomationListEmptyView'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import type { AutomationHostFilterResolution } from './automation-host-filter-resolution'

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

function hostResolution(host = entry()): AutomationHostFilterResolution {
  return {
    effective: { kind: 'host', host: host.stableRef },
    entry: host,
    status: 'ready',
    announceFallback: false
  }
}

function render(overrides: Partial<AutomationListEmptyViewProps> = {}): void {
  act(() => {
    root.render(
      <AutomationListEmptyView
        resolution={hostResolution()}
        hostRowCount={0}
        visibleRowCount={0}
        searchActive={false}
        {...overrides}
      />
    )
  })
}

describe('AutomationListEmptyView', () => {
  it('renders nothing while rows exist', () => {
    render({ visibleRowCount: 4 })
    expect(container.querySelector('[data-empty-state]')).toBeNull()
  })

  it('shows the single-host empty copy', () => {
    render()
    const state = container.querySelector('[data-empty-state="host-empty"]')
    expect(state?.textContent).toContain('No automations on web-01')
  })

  it('never renders an empty claim for a disconnected host', () => {
    render({ resolution: hostResolution(entry({ executionHealth: 'disconnected' })) })
    expect(container.querySelector('[data-empty-state="host-empty"]')).toBeNull()
    expect(container.textContent).not.toContain('No automations')
    expect(container.querySelector('[data-empty-state="host-not-connected"]')).not.toBeNull()
  })

  it('invokes the recovery action the failure calls for', () => {
    const onRecover = vi.fn()
    render({
      resolution: hostResolution(entry({ authorityHealth: 'stale-error' })),
      onRecover
    })
    const button = container.querySelector('button')
    expect(button?.textContent).toBe('Retry')

    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onRecover).toHaveBeenCalledWith('retry')
  })

  it('omits the recovery button when the caller offers no handler', () => {
    render({ resolution: hostResolution(entry({ authorityHealth: 'stale-error' })) })
    expect(container.querySelector('button')).toBeNull()
  })
})
