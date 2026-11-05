// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  AutomationHostFilterNotice,
  AutomationHostLoadSummary,
  automationHostLoadSummaryMessage
} from './AutomationHostFilterNotice'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import type {
  AutomationHostFilterResolution,
  AutomationHostFilterStatus
} from './automation-host-filter-resolution'

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

function resolution(
  status: AutomationHostFilterStatus,
  overrides: Partial<AutomationHostFilterResolution> = {}
): AutomationHostFilterResolution {
  return {
    effective: status === 'all' ? { kind: 'all' } : { kind: 'host', host: entry().stableRef },
    entry: status === 'all' ? null : entry(),
    status,
    announceFallback: false,
    ...overrides
  }
}

function renderNotice(
  value: AutomationHostFilterResolution,
  onRecover?: (action: 'retry' | 'reconnect' | 'update-server') => void
): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <AutomationHostFilterNotice resolution={value} onRecover={onRecover} />
      </TooltipProvider>
    )
  })
}

function liveRegionText(): string {
  return [...container.querySelectorAll('[aria-live="polite"]')]
    .map((node) => node.textContent ?? '')
    .join(' ')
    .trim()
}

describe('AutomationHostFilterNotice', () => {
  it('stays silent when the selection is healthy', () => {
    renderNotice(resolution('all'))
    expect(container.querySelector('[data-filter-status]')).toBeNull()
    renderNotice(resolution('ready'))
    expect(container.querySelector('[data-filter-status]')).toBeNull()
  })

  const NOTICED: AutomationHostFilterStatus[] = ['loading', 'unavailable', 'ghost', 'removed']
  it.each(NOTICED)('surfaces the %s status inline', (status) => {
    renderNotice(resolution(status))
    const notice = container.querySelector('[data-filter-status]')
    expect(notice?.getAttribute('data-filter-status')).toBe(status)
    expect(notice?.textContent?.length).toBeGreaterThan(0)
  })

  it('reports a removed host as still listed rather than as data loss', () => {
    renderNotice(resolution('ghost'))
    expect(container.querySelector('[data-filter-status="ghost"]')?.textContent).toContain(
      'web-01 was removed. Automations still assigned to it remain listed.'
    )
  })

  it('announces the fallback to All hosts', () => {
    renderNotice(resolution('all', { announceFallback: true }))
    expect(liveRegionText()).toBe('The selected host is no longer available. Showing all hosts.')
  })

  it('says nothing when no fallback happened', () => {
    renderNotice(resolution('all'))
    expect(liveRegionText()).toBe('')
  })

  it('keeps the polite region mounted while there is nothing to announce', () => {
    renderNotice(resolution('all'))
    expect(container.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull()
  })

  it('announces into the region that was already on the page', () => {
    renderNotice(resolution('all'))
    const before = container.querySelector('[role="status"][aria-live="polite"]')

    renderNotice(resolution('all', { announceFallback: true }))

    // A region inserted with its text already in it is not a change screen readers report.
    expect(container.querySelector('[role="status"][aria-live="polite"]')).toBe(before)
  })

  it('offers the recovery action for the failure it actually has', () => {
    const onRecover = vi.fn()
    renderNotice(
      resolution('unavailable', { entry: entry({ authorityHealth: 'unavailable' }) }),
      onRecover
    )
    const button = container.querySelector('button')
    expect(button?.textContent).toBe('Reconnect')

    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onRecover).toHaveBeenCalledWith('reconnect')
  })

  it('offers Update server for a legacy-unscoped contract', () => {
    renderNotice(
      resolution('ghost', { entry: entry({ querySupport: 'legacy-unscoped' }) }),
      () => undefined
    )
    expect(container.querySelector('button')?.textContent).toBe('Update server')
  })

  it('does not move focus when the notice appears', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    renderNotice(resolution('unavailable'))

    expect(document.activeElement).toBe(input)
    input.remove()
  })
})

describe('AutomationHostLoadSummary', () => {
  function renderSummary(failed: number, total: number): void {
    act(() => {
      root.render(<AutomationHostLoadSummary failedHostCount={failed} totalHostCount={total} />)
    })
  }

  it('words the partial failure exactly as specified', () => {
    expect(automationHostLoadSummaryMessage(2, 5)).toBe('2 of 5 hosts could not be loaded')
  })

  it('says nothing when every host loaded', () => {
    renderSummary(0, 5)
    expect(liveRegionText()).toBe('')
  })

  it('announces politely rather than assertively', () => {
    renderSummary(2, 5)
    const region = container.querySelector('[aria-live]')
    expect(region?.getAttribute('aria-live')).toBe('polite')
    expect(region?.textContent).toBe('2 of 5 hosts could not be loaded')
  })

  it('does not re-announce when a retry leaves the failed count unchanged', () => {
    renderSummary(2, 5)
    const first = container.querySelector('[aria-live]')?.firstChild
    renderSummary(2, 6)
    expect(container.querySelector('[aria-live]')?.textContent).toBe(
      '2 of 5 hosts could not be loaded'
    )
    // The same text node survives, so assistive tech sees no change to announce.
    expect(container.querySelector('[aria-live]')?.firstChild).toBe(first)
  })

  it('re-announces when the failed count changes', () => {
    renderSummary(2, 5)
    renderSummary(1, 5)
    expect(container.querySelector('[aria-live]')?.textContent).toBe(
      '1 of 5 hosts could not be loaded'
    )
  })
})
