// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationOwnerRef } from '../../../../shared/automation-owner-ref'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import { useExternalAutomationScopeRetention } from './use-external-automation-scope-retention'

const retainExternalScopes =
  vi.fn<(request: { owners: readonly AutomationOwnerRef[] }) => Promise<void>>()

let container: HTMLDivElement
let root: Root

function entry(overrides: Partial<AutomationHostCatalogEntry> = {}): AutomationHostCatalogEntry {
  return {
    stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
    owner: { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
    stableKey: 'host:desktop:self',
    label: 'This computer',
    authorityLabel: 'This computer',
    kind: 'self',
    catalogState: 'authoritative',
    authorityHealth: 'fresh',
    executionHealth: 'connected',
    querySupport: 'scoped',
    ...overrides
  }
}

function sshEntry(targetId: string, targetGeneration = 3): AutomationHostCatalogEntry {
  return entry({
    stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId } },
    owner: {
      authority: { kind: 'desktop' },
      selector: { kind: 'ssh', targetId, targetGeneration }
    },
    stableKey: `host:desktop:ssh:${targetId}`,
    label: targetId,
    kind: 'ssh'
  })
}

const runtimeEntry = entry({
  stableRef: { authority: { kind: 'runtime', environmentId: 'env-1' }, selector: { kind: 'self' } },
  owner: {
    authority: { kind: 'runtime', environmentId: 'env-1', pairingRevision: 1 },
    selector: { kind: 'self' }
  },
  stableKey: 'host:runtime:env-1:self',
  label: 'Build box'
})

function Harness({ entries }: { entries: readonly AutomationHostCatalogEntry[] }): null {
  useExternalAutomationScopeRetention(entries)
  return null
}

function render(entries: readonly AutomationHostCatalogEntry[]): void {
  act(() => {
    root.render(<Harness entries={entries} />)
  })
}

function retainedOwners(callIndex: number): readonly AutomationOwnerRef[] {
  return retainExternalScopes.mock.calls[callIndex]?.[0].owners ?? []
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  retainExternalScopes.mockReset()
  retainExternalScopes.mockResolvedValue(undefined)
  Object.assign(window, { api: { automations: { retainExternalScopes } } })
})

afterEach(() => {
  container.remove()
})

describe('useExternalAutomationScopeRetention', () => {
  it('retains only the hosts whose managers are actually listed', () => {
    render([entry(), runtimeEntry, sshEntry('t1')])

    expect(retainExternalScopes).toHaveBeenCalledTimes(1)
    expect(retainedOwners(0)).toEqual([
      { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
      {
        authority: { kind: 'desktop' },
        selector: { kind: 'ssh', targetId: 't1', targetGeneration: 3 }
      }
    ])
    act(() => root.unmount())
  })

  it('does not restart in-flight probes when the same scope set re-renders', () => {
    render([entry(), sshEntry('t1')])
    render([entry(), sshEntry('t1')])

    expect(retainExternalScopes).toHaveBeenCalledTimes(1)
    act(() => root.unmount())
  })

  it('drops a host as soon as the filter moves off it', () => {
    render([entry(), sshEntry('t1')])
    render([sshEntry('t1')])

    expect(retainExternalScopes).toHaveBeenCalledTimes(2)
    expect(retainedOwners(1)).toEqual([
      {
        authority: { kind: 'desktop' },
        selector: { kind: 'ssh', targetId: 't1', targetGeneration: 3 }
      }
    ])
    act(() => root.unmount())
  })

  it('re-retains when a host is re-added under a new incarnation', () => {
    render([sshEntry('t1', 3)])
    render([sshEntry('t1', 4)])

    expect(retainExternalScopes).toHaveBeenCalledTimes(2)
    expect(retainedOwners(1)).toEqual([
      {
        authority: { kind: 'desktop' },
        selector: { kind: 'ssh', targetId: 't1', targetGeneration: 4 }
      }
    ])
    act(() => root.unmount())
  })

  it('retains nothing once the page unmounts', () => {
    render([entry()])
    act(() => root.unmount())

    expect(retainedOwners(retainExternalScopes.mock.calls.length - 1)).toEqual([])
  })
})
