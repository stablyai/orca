// @vitest-environment happy-dom

/**
 * The detail view never said which machine an automation lived on, so two rows
 * from different hosts read identically. These pin the host to the row's own
 * catalog entry rather than to the record's host-local execution target.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Automation } from '../../../../shared/automations-types'
import { AutomationDetail } from './AutomationDetail'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import { makeAutomation } from './automations-page-fixtures'

const roots: Root[] = []

const RUNTIME_ENTRY: AutomationHostCatalogEntry = {
  stableRef: { authority: { kind: 'runtime', environmentId: 'r1' }, selector: { kind: 'self' } },
  owner: {
    authority: { kind: 'runtime', environmentId: 'r1', pairingRevision: 1 },
    selector: { kind: 'self' }
  },
  stableKey: 'host:runtime:r1:self',
  label: 'GPU box',
  authorityLabel: 'GPU box',
  kind: 'self',
  catalogState: 'authoritative',
  authorityHealth: 'fresh',
  executionHealth: 'connected',
  querySupport: 'scoped'
}

async function render(
  overrides: Partial<Automation>,
  hostEntry: AutomationHostCatalogEntry | null
): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <TooltipProvider>
        <AutomationDetail
          automation={makeAutomation(overrides)}
          runs={[]}
          projectName="orca"
          workspaceName="main"
          projectDefaultBaseRef="main"
          hostEntry={hostEntry}
          hostLabelById={new Map([['local', 'Local Mac']])}
          runNowAvailability={null}
          now={0}
          onRunNow={vi.fn()}
          onEdit={vi.fn()}
          onToggle={vi.fn()}
          onDelete={vi.fn()}
        />
      </TooltipProvider>
    )
  })
  return container
}

function hostMetric(container: HTMLDivElement): string | null {
  const label = [...container.querySelectorAll('div')].find(
    (node) => node.textContent === 'Host' && node.className.includes('uppercase')
  )
  return label?.nextElementSibling?.textContent ?? null
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount())
  })
  document.body.innerHTML = ''
})

describe('AutomationDetail host', () => {
  it('names the host the row was listed from', async () => {
    // executionTargetType 'local' means local to the runtime, so the record
    // alone would have this read as this Mac.
    const container = await render({ executionTargetType: 'local' }, RUNTIME_ENTRY)

    expect(hostMetric(container)).toBe('GPU box')
  })

  it('falls back to the record’s own target when no host answered for the row', async () => {
    const container = await render({ executionTargetType: 'local' }, null)

    expect(hostMetric(container)).toBe('Local Mac')
  })
})
