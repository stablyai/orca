// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  AutomationCatalogHydrationEvidence,
  AutomationHostCatalogEntry
} from './automation-host-catalog-types'
import {
  useAutomationCreateDestination,
  type AutomationCreateDestinationInput
} from './use-automation-create-destination'

const desktop: AutomationHostCatalogEntry = {
  stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
  owner: { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
  stableKey: 'desktop:self',
  label: 'This computer',
  authorityLabel: 'Desktop',
  kind: 'self',
  catalogState: 'authoritative',
  authorityHealth: 'fresh',
  executionHealth: 'connected',
  querySupport: 'scoped'
}
const ssh: AutomationHostCatalogEntry = {
  ...desktop,
  stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId: 'box' } },
  owner: {
    authority: { kind: 'desktop' },
    selector: { kind: 'ssh', targetId: 'box', targetGeneration: 1 }
  },
  stableKey: 'desktop:ssh:box',
  label: 'SSH box',
  kind: 'ssh'
}
const hydrated: AutomationCatalogHydrationEvidence = {
  runtimeCatalogSettled: true,
  desktopSshHydrated: true,
  runtimeSshHydratedByEnvironmentId: new Map(),
  savedRuntimeEnvironmentIds: new Set(),
  orphanSettledAuthorityKeys: new Set(),
  unavailableAuthorityKeys: new Set()
}

function input(
  entries: readonly AutomationHostCatalogEntry[] = [desktop, ssh],
  overrides: Partial<AutomationCreateDestinationInput> = {}
): AutomationCreateDestinationInput {
  return {
    open: true,
    entries,
    catalog: {
      entries,
      byStableKey: new Map(entries.map((entry) => [entry.stableKey, entry])),
      hydration: hydrated
    },
    filterStableKey: null,
    activeWorkspaceStableKey: null,
    repoTables: new Map(),
    projects: [],
    ...overrides
  }
}

afterEach(cleanup)

describe('automation create destination dirty state', () => {
  it('keeps the initially captured host clean', () => {
    const { result } = renderHook(useAutomationCreateDestination, {
      initialProps: input([desktop, ssh], { activeWorkspaceStableKey: desktop.stableKey })
    })

    expect(result.current.control.resolution).toMatchObject({
      status: 'ready',
      entry: { stableKey: desktop.stableKey }
    })
    expect(result.current.hasUnsavedChanges).toBe(false)
  })

  it('marks a host change dirty and becomes clean when the initial host is restored', () => {
    const { result } = renderHook(useAutomationCreateDestination, {
      initialProps: input([desktop, ssh], { filterStableKey: desktop.stableKey })
    })

    act(() => result.current.control.onSelect(ssh.stableKey))

    expect(result.current.control.resolution).toMatchObject({
      status: 'ready',
      entry: { stableKey: ssh.stableKey }
    })
    expect(result.current.hasUnsavedChanges).toBe(true)

    act(() => result.current.control.onSelect(desktop.stableKey))

    expect(result.current.hasUnsavedChanges).toBe(false)
  })

  it('marks an explicit selection dirty when the dialog started without a host', () => {
    const { result } = renderHook(useAutomationCreateDestination, { initialProps: input() })

    expect(result.current.control.resolution.status).toBe('choice-required')
    expect(result.current.hasUnsavedChanges).toBe(false)

    act(() => result.current.control.onSelect(ssh.stableKey))

    expect(result.current.control.resolution).toMatchObject({
      status: 'ready',
      entry: { stableKey: ssh.stableKey }
    })
    expect(result.current.hasUnsavedChanges).toBe(true)
  })

  it('resets the capture and dirty baseline when closed and reopened', () => {
    const initialProps = input([desktop, ssh], { filterStableKey: desktop.stableKey })
    const { result, rerender } = renderHook(useAutomationCreateDestination, { initialProps })

    act(() => result.current.control.onSelect(ssh.stableKey))
    expect(result.current.hasUnsavedChanges).toBe(true)

    rerender({ ...initialProps, open: false })

    expect(result.current.control.resolution.status).toBe('choice-required')
    expect(result.current.hasUnsavedChanges).toBe(false)

    rerender({ ...initialProps, filterStableKey: ssh.stableKey })

    expect(result.current.control.resolution).toMatchObject({
      status: 'ready',
      entry: { stableKey: ssh.stableKey }
    })
    expect(result.current.hasUnsavedChanges).toBe(false)

    act(() => result.current.control.onSelect(desktop.stableKey))
    expect(result.current.hasUnsavedChanges).toBe(true)
  })

  it('keeps a late automatic capture clean after catalog hydration settles', () => {
    const pending = input([desktop])
    pending.catalog = {
      ...pending.catalog,
      hydration: { ...hydrated, runtimeCatalogSettled: false }
    }
    const { result, rerender } = renderHook(useAutomationCreateDestination, {
      initialProps: pending
    })

    expect(result.current.control.resolution.status).toBe('choice-required')
    expect(result.current.hasUnsavedChanges).toBe(false)

    rerender(input([desktop]))

    expect(result.current.control.resolution).toMatchObject({
      status: 'ready',
      entry: { stableKey: desktop.stableKey }
    })
    expect(result.current.hasUnsavedChanges).toBe(false)
  })
})
