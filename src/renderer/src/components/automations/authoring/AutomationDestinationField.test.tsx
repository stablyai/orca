// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AutomationDestinationField } from './AutomationDestinationField'
import type { AutomationHostCatalogEntry } from '../hosts/automation-host-catalog-types'
import type { AutomationOwnerRef } from '../../../../../shared/automations/ownership/automation-owner-ref'
import type { AutomationCreateDestinationControl } from './use-automation-create-destination'
import type { Repo } from '../../../../../shared/repository/repo-types'

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
  label: 'linux-box',
  authorityLabel: 'Local Mac',
  kind: 'ssh',
  catalogState: 'authoritative',
  authorityHealth: 'fresh',
  executionHealth: 'connected',
  querySupport: 'scoped'
}

function control(
  projects: Repo[],
  entries: AutomationHostCatalogEntry[] = [ENTRY],
  moveWarning?: string,
  recordedProject?: AutomationCreateDestinationControl['recordedProject']
): AutomationCreateDestinationControl {
  return {
    entries,
    moveWarning,
    recordedProject,
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
  moveWarning?: string,
  recordedProject?: AutomationCreateDestinationControl['recordedProject'],
  hasBots?: boolean
): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <AutomationDestinationField
          control={control(projects, entries, moveWarning, recordedProject)}
          hasBots={hasBots}
        />
      </TooltipProvider>
    )
  })
}

function emptyNote(): HTMLElement | null {
  return container.querySelector('[data-testid="automation-create-no-projects"]')
}

describe('AutomationDestinationField', () => {
  it('says nothing about missing projects when a bot can be picked instead', () => {
    render([], undefined, undefined, undefined, true)

    expect(emptyNote()).toBeNull()
    expect(container.textContent).toContain('Stored and scheduled by')
  })
})
