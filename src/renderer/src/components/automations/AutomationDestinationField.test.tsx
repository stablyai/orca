// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AutomationDestinationField } from './AutomationDestinationField'
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
  entries: AutomationHostCatalogEntry[] = [ENTRY],
  moveWarning?: string
): AutomationCreateDestinationControl {
  return {
    entries,
    moveWarning,
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

function render(
  projects: Repo[],
  entries?: AutomationHostCatalogEntry[],
  moveWarning?: string
): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <AutomationDestinationField control={control(projects, entries, moveWarning)} />
      </TooltipProvider>
    )
  })
}

function emptyNote(): HTMLElement | null {
  return container.querySelector('[data-testid="automation-create-no-projects"]')
}

describe('AutomationDestinationField', () => {
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

    const updateRequired = container.querySelector(
      '[data-testid="automation-create-update-required"]'
    )
    expect(updateRequired?.textContent).toContain('legacy-box')
  })

  it('says nothing about updates when every offered host is eligible', () => {
    render([{ id: 'repo-1' } as Repo])

    expect(container.querySelector('[data-testid="automation-create-update-required"]')).toBeNull()
  })

  it('states a move in place of the host it would otherwise just name', () => {
    render([{ id: 'repo-1' } as Repo], undefined, 'Saving creates this automation on GPU box.')

    // Both lines name the same host; the one that mentions the delete wins.
    expect(container.querySelector('[data-testid="automation-host-move"]')?.textContent).toContain(
      'GPU box'
    )
    expect(container.textContent).not.toContain('Stored and scheduled by')
  })

  it('names the host without a tense, so editing reads as a move', () => {
    render([{ id: 'repo-1' } as Repo])

    // The same field serves both modes; create-only wording would misread on an
    // existing record, whose save moves it rather than creating it.
    expect(container.querySelector('[aria-label="Host"]')).not.toBeNull()
    expect(container.textContent).not.toContain('created')
  })
})
