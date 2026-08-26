// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AutomationCreateDestinationField } from './AutomationCreateDestinationField'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import type { AutomationOwnerRef } from '../../../../shared/automation-owner-ref'
import type { AutomationCreateDestinationControl } from './use-automation-create-destination'
import type { Repo } from '../../../../shared/repo-types'

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

const OWNER: AutomationOwnerRef = {
  authority: { kind: 'desktop' },
  selector: { kind: 'ssh', targetId: 't1', targetGeneration: 1 }
}

const ENTRY: AutomationHostCatalogEntry = {
  stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId: 't1' } },
  owner: OWNER,
  stableKey: 'host:desktop:ssh:t1',
  label: 'openclaw',
  authorityLabel: 'Local Mac',
  kind: 'ssh',
  catalogState: 'authoritative',
  authorityHealth: 'fresh',
  executionHealth: 'connected',
  querySupport: 'scoped'
}

const LEGACY_ENTRY: AutomationHostCatalogEntry = {
  stableRef: { authority: { kind: 'runtime', environmentId: 'r1' }, selector: { kind: 'self' } },
  owner: {
    authority: { kind: 'runtime', environmentId: 'r1', pairingRevision: 1 },
    selector: { kind: 'self' }
  },
  stableKey: 'host:runtime:r1:self',
  label: 'legacy-box',
  authorityLabel: 'legacy-box',
  kind: 'self',
  catalogState: 'authoritative',
  authorityHealth: 'fresh',
  executionHealth: 'connected',
  querySupport: 'legacy-unscoped',
  scopeGap: 'authority-unscoped'
}

function control(
  projects: Repo[],
  entries: AutomationHostCatalogEntry[] = [ENTRY]
): AutomationCreateDestinationControl {
  return {
    entries,
    resolution: {
      status: 'ready',
      authority: OWNER.authority,
      destination: { selector: OWNER.selector },
      entry: ENTRY
    },
    onSelect: () => undefined,
    projects
  }
}

function render(projects: Repo[], entries?: AutomationHostCatalogEntry[]): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <AutomationCreateDestinationField control={control(projects, entries)} />
      </TooltipProvider>
    )
  })
}

function emptyNote(): HTMLElement | null {
  return container.querySelector('[data-testid="automation-create-no-projects"]')
}

describe('AutomationCreateDestinationField', () => {
  it('names the host that has no projects rather than leaving Create dead', () => {
    render([])

    expect(emptyNote()?.textContent).toContain('openclaw')
  })

  it('states the storing authority once the host has a project to offer', () => {
    render([{ id: 'repo-1' } as Repo])

    expect(emptyNote()).toBeNull()
    expect(container.textContent).toContain('Local Mac')
  })

  it('names the hosts a server update would let create, instead of hiding them', () => {
    render([{ id: 'repo-1' } as Repo], [ENTRY, LEGACY_ENTRY])

    const note = container.querySelector('[data-testid="automation-create-update-required"]')
    expect(note?.textContent).toContain('legacy-box')
  })

  it('says nothing about updates when every offered host is eligible', () => {
    render([{ id: 'repo-1' } as Repo])

    expect(container.querySelector('[data-testid="automation-create-update-required"]')).toBeNull()
  })
})
