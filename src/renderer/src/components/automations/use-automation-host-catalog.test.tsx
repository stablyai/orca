// @vitest-environment happy-dom

/** Drive the real authority-specific legacy partition context; mock transports only so colliding desktop repo IDs cannot stand in for runtime evidence. */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import type { AppState } from '@/store'
import type { Repo } from '../../../../shared/repo-types'
import type { AutomationHostCatalogView } from './use-automation-host-catalog'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  listeners: new Set<() => void>(),
  renders: 0,
  failureCountOnly: false,
  callRuntimeRpc: vi.fn(),
  getRuntimeEnvironmentStatus: vi.fn()
}))

vi.mock('@/store', async () => {
  const { useSyncExternalStore } = await import('react')
  const subscribe = (listener: () => void) => {
    mocks.listeners.add(listener)
    return () => {
      mocks.listeners.delete(listener)
    }
  }
  const useAppStore = (selector: (state: Partial<AppState>) => unknown): unknown =>
    useSyncExternalStore(subscribe, () => selector(mocks.state as Partial<AppState>))
  useAppStore.getState = (): Partial<AppState> => mocks.state as Partial<AppState>
  return { useAppStore }
})

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => mocks.callRuntimeRpc(...args),
  getRuntimeEnvironmentStatus: (...args: unknown[]) => mocks.getRuntimeEnvironmentStatus(...args)
}))
vi.mock('@/runtime/runtime-rpc-result', () => ({ hasRuntimeRpcErrorCode: () => false }))

import { useAutomationHostCatalog } from './use-automation-host-catalog'
import { resetAutomationCapabilityProbes } from './automation-capability-probe'
import {
  AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY,
  AUTOMATION_RUN_SEEN_CAPABILITY
} from '../../../../shared/automation-runtime-capabilities'

const ENVIRONMENT_ID = 'env-1'
const PROJECT_ID = 'shared-project'
const RUNTIME_AUTHORITY_KEY = `authority:runtime:${ENVIRONMENT_ID}`

function repo(overrides: Partial<Repo> & { id: string }): Repo {
  return {
    path: `/repos/${overrides.id}`,
    displayName: overrides.id,
    badgeColor: 'blue',
    addedAt: 0,
    ...overrides
  } as Repo
}

function legacyAutomation(): Automation {
  return {
    id: 'a-legacy',
    name: 'Nightly on the build box',
    prompt: 'go',
    precheck: null,
    agentId: 'claude',
    projectId: PROJECT_ID,
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 0,
    enabled: true,
    nextRunAt: 0,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 0,
    updatedAt: 0
  } as Automation
}

function storeState(repos: readonly Repo[]): Record<string, unknown> {
  const noop = (): void => undefined
  return {
    repos,
    settings: null,
    sshConnectionStates: new Map(),
    sshTargetLabels: new Map(),
    sshTargetGenerations: new Map(),
    removedSshTargetLabels: new Map(),
    sshTargetsHydrated: true,
    sshStateByEnvironment: new Map(),
    runtimeEnvironments: [
      { id: ENVIRONMENT_ID, name: 'Build box', createdAt: 1, pairingRevision: 1 }
    ],
    runtimeEnvironmentCatalogSettled: true,
    // No host-scope capability: this is the New-desktop/Old-runtime matrix row.
    runtimeStatusByEnvironmentId: new Map([[ENVIRONMENT_ID, { status: { capabilities: [] } }]]),
    automationHostFilter: { kind: 'all' },
    setAutomationHostFilter: noop,
    openSettingsPage: noop,
    openSettingsTarget: noop
  }
}

const roots: Root[] = []
let view: AutomationHostCatalogView | null = null

function Harness(): null {
  mocks.renders++
  view = useAutomationHostCatalog({ failureCountOnly: mocks.failureCountOnly })
  return null
}

async function renderCatalog(repos: readonly Repo[]): Promise<void> {
  mocks.state = storeState(repos)
  await renderCatalogWithState()
}

async function renderCatalogWithState(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<Harness />)
  })
  // The legacy answer commits through the cache and re-renders the view.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** What the Runtime + Self row group actually shows for the old runtime. */
function runtimeSelfAutomationIds(): string[] {
  const group = view?.rows.groups.find((entry) => entry.authorityKey === RUNTIME_AUTHORITY_KEY)
  const host = group?.hosts.find((candidate) => candidate.entry.kind === 'self')
  return (host?.rows ?? []).map((row) => row.automation.id)
}

/** The desktop authority's scoped-list answer, served on the local runtime target. */
let desktopListScoped = vi.fn()

beforeEach(() => {
  resetAutomationCapabilityProbes()
  mocks.failureCountOnly = false
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  view = null
  mocks.callRuntimeRpc.mockReset()
  mocks.getRuntimeEnvironmentStatus.mockReset()
  desktopListScoped = vi.fn().mockResolvedValue({ automations: [], items: [], orphanCount: 0 })
  mocks.callRuntimeRpc.mockImplementation(async (target: unknown, _method: string, params) => {
    if ((target as { kind?: string } | null)?.kind === 'local') {
      return await desktopListScoped(params)
    }
    return { automations: [legacyAutomation()] }
  })
  mocks.getRuntimeEnvironmentStatus.mockResolvedValue({ capabilities: [] })
  Object.assign(window, {
    api: {
      ssh: { connect: vi.fn() },
      runtimeEnvironments: { connect: vi.fn() }
    }
  })
})

afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount())
  })
  Reflect.deleteProperty(globalThis, '__ORCA_WEB_CLIENT__')
  document.body.innerHTML = ''
})

describe('useAutomationHostCatalog orphan bootstrap', () => {
  it('projects the orphan entry a host answer reported', async () => {
    desktopListScoped.mockResolvedValue({ automations: [], items: [], orphanCount: 2 })

    await renderCatalog([])

    // Committed orphan counts arrive only through cache changes; rederive the catalog without requiring a store write.
    expect(view?.catalog.entries.map((entry) => entry.stableKey)).toContain('host:desktop:orphan')
  })
})

describe('useAutomationHostCatalog on a paired web client', () => {
  const runtimeSelf = {
    authority: { kind: 'runtime', environmentId: ENVIRONMENT_ID },
    selector: { kind: 'self' }
  }

  beforeEach(() => {
    Object.assign(globalThis, { __ORCA_WEB_CLIENT__: true })
  })

  // #32415: the browser's local transport is its server's, so Desktop listed the same records again.
  it('lists the paired server once instead of again as Desktop', async () => {
    await renderCatalog([repo({ id: PROJECT_ID, executionHostId: `runtime:${ENVIRONMENT_ID}` })])

    expect(view?.catalog.entries.map((entry) => entry.stableRef)).toEqual([runtimeSelf])
    expect(view?.rows.groups.flatMap((group) => group.hosts.flatMap((host) => host.rows))).toEqual([
      expect.objectContaining({ automation: expect.objectContaining({ id: 'a-legacy' }) })
    ])
    expect(desktopListScoped).not.toHaveBeenCalled()
  })

  it('moves a saved Desktop filter to the server instead of waiting forever for Desktop', async () => {
    mocks.state = {
      ...storeState([]),
      automationHostFilter: {
        kind: 'host',
        host: { authority: { kind: 'desktop' }, selector: { kind: 'self' } }
      }
    }

    await renderCatalogWithState()

    expect(view?.resolution).toMatchObject({
      status: 'ready',
      announceFallback: false,
      effective: { kind: 'host', host: runtimeSelf }
    })
  })
})

describe('useAutomationHostCatalog legacy partitioning', () => {
  it('does not let a same-id desktop project claim an old runtime record for Self', async () => {
    await renderCatalog([repo({ id: PROJECT_ID })])

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: ENVIRONMENT_ID },
      'automation.list',
      null,
      expect.anything()
    )
    expect(runtimeSelfAutomationIds()).toEqual([])
  })

  it('classifies the record as Self from the runtime’s own mirrored project', async () => {
    await renderCatalog([
      repo({ id: PROJECT_ID, executionHostId: `runtime:${ENVIRONMENT_ID}` }),
      // Listed last so a bare-ID table would answer with this desktop SSH repo.
      repo({ id: PROJECT_ID, connectionId: 'devbox' })
    ])

    expect(runtimeSelfAutomationIds()).toEqual(['a-legacy'])
  })
})

it.each([1_000, 10_000])(
  'keeps settled catalog consumers quiet for unused settings among %i host overrides, but updates a used failure count',
  async (size) => {
    let upstreamReads = 0
    const overrides = Object.fromEntries(
      Array.from({ length: size }, (_, index) => [
        `runtime:unused-${index}`,
        {
          get displayLabel() {
            upstreamReads++
            return `Other ${index}`
          }
        }
      ])
    )
    let settings = { theme: 'light', hostSettingOverrides: overrides }
    const automation = legacyAutomation()
    let count = 0
    desktopListScoped.mockImplementation(async () => ({
      automations: [automation],
      items: [
        { automationId: automation.id, selector: { kind: 'self' }, unseenFailureCount: count }
      ],
      orphanCount: 0
    }))
    mocks.state = { ...storeState([]), runtimeEnvironments: [], settings }
    await renderCatalogWithState()
    expect(view?.unseenFailureCount).toBe(0)
    const settledRenders = mocks.renders
    upstreamReads = 0
    await act(async () => {
      settings = { ...settings, theme: 'dark' }
      mocks.state = { ...mocks.state, settings }
      mocks.listeners.forEach((notify) => notify())
    })
    expect(mocks.renders).toBe(settledRenders)
    expect(upstreamReads).toBe(0)
    await act(async () => {
      settings = {
        ...settings,
        hostSettingOverrides: {
          ...overrides,
          'runtime:unrelated': { displayLabel: 'Changed elsewhere' }
        }
      }
      mocks.state = { ...mocks.state, settings }
      mocks.listeners.forEach((notify) => notify())
    })
    expect(mocks.renders).toBe(settledRenders)
    expect(upstreamReads).toBe(0)
    await act(async () => {
      count = 1
      view?.notifyAuthorityChange({
        authority: { kind: 'desktop' },
        selector: { kind: 'self' },
        reason: 'run'
      })
    })
    expect(view?.unseenFailureCount).toBe(1)
    expect(mocks.renders).toBeGreaterThan(settledRenders)
    expect(upstreamReads).toBe(0)
  }
)

it('keeps the badge count consumer quiet for equal other-host refreshes and updates the global total', async () => {
  mocks.failureCountOnly = true
  const capabilities = [
    AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY,
    AUTOMATION_RUN_SEEN_CAPABILITY
  ]
  mocks.state = storeState([repo({ id: PROJECT_ID, executionHostId: `runtime:${ENVIRONMENT_ID}` })])
  mocks.state.runtimeStatusByEnvironmentId = new Map([
    [ENVIRONMENT_ID, { status: { capabilities } }]
  ])
  mocks.getRuntimeEnvironmentStatus.mockResolvedValue({ capabilities })
  const initial = mocks.callRuntimeRpc.getMockImplementation()!
  mocks.callRuntimeRpc.mockImplementation(async (...args) => {
    const result = await initial(...args)
    return args[1] === 'automation.list' && args[0]?.kind !== 'local'
      ? {
          ...result,
          items: [{ automationId: 'a-legacy', selector: { kind: 'self' }, unseenFailureCount: 0 }],
          orphanCount: 0
        }
      : result
  })
  await renderCatalogWithState()
  const renders = mocks.renders
  const localReads = desktopListScoped.mock.calls.length
  const remoteReads = mocks.callRuntimeRpc.mock.calls.length
  const original = mocks.callRuntimeRpc.getMockImplementation()!
  let count = 0
  mocks.callRuntimeRpc.mockImplementation(async (...args) => {
    const result = await original(...args)
    if (args[1] === 'automation.list') {
      return {
        ...result,
        items: [{ automationId: 'a-legacy', selector: { kind: 'self' }, unseenFailureCount: count }]
      }
    }
    return result
  })
  await act(async () => {
    view?.notifyAuthorityChange({
      authority: { kind: 'runtime', environmentId: ENVIRONMENT_ID },
      selector: { kind: 'self' },
      reason: 'usage'
    })
  })
  expect(mocks.callRuntimeRpc.mock.calls.length).toBeGreaterThan(remoteReads)
  expect(desktopListScoped).toHaveBeenCalledTimes(localReads)
  expect(mocks.renders).toBe(renders)
  await act(async () => {
    count = 1
    view?.notifyAuthorityChange({
      authority: { kind: 'runtime', environmentId: ENVIRONMENT_ID },
      selector: { kind: 'self' },
      reason: 'run'
    })
  })
  expect(view?.unseenFailureCount).toBe(1)
  expect(mocks.renders).toBeGreaterThan(renders)
})
