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

function control(projects: Repo[]): AutomationCreateDestinationControl {
  return {
    entries: [ENTRY],
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

function render(projects: Repo[]): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <AutomationCreateDestinationField control={control(projects)} />
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
})
