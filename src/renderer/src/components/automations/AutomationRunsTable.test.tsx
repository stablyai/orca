// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import type { AutomationRunsDashboardEntry } from './automation-runs-dashboard-model'
import { AutomationRunsTable } from './AutomationRunsTable'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({
    count,
    getItemKey
  }: {
    count: number
    getItemKey: (index: number) => string
  }) => ({
    getTotalSize: () => count * 59,
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 21) }, (_, index) => ({
        index,
        key: getItemKey(index),
        start: index * 59
      })),
    measureElement: () => undefined
  })
}))

function entries(count: number): AutomationRunsDashboardEntry[] {
  const automation = { id: 'automation', name: 'Daily check' } as Automation
  const row = {
    key: 'row',
    automation,
    catalogRef: { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
    hostLabel: 'Local Mac',
    usageSummary: null
  } as const
  return Array.from({ length: count }, (_, index) => ({
    key: `row:run-${index}`,
    hostKey: 'desktop:self',
    searchText: `daily check run ${index} local mac`,
    row,
    run: {
      id: `run-${index}`,
      automationId: automation.id,
      title: `Run ${index}`,
      scheduledFor: index,
      trigger: 'scheduled',
      status: 'completed'
    } as AutomationRun,
    scope: 'local'
  }))
}

describe('AutomationRunsTable virtualization', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('keeps a 10,000-run history to a bounded number of mounted rows', () => {
    act(() => {
      root.render(
        <AutomationRunsTable
          entries={entries(10_000)}
          loading={false}
          hasMore={false}
          onLoadMore={() => {}}
          onOpenRun={() => {}}
        />
      )
    })

    const mountedRows = container.querySelectorAll('[data-testid="automation-runs-row"]')
    expect(mountedRows).toHaveLength(21)
  })
})
