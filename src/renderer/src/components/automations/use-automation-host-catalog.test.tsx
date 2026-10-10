// @vitest-environment happy-dom

/**
 * Drives the real partition context the hook builds, not a stand-in for it.
 *
 * The legacy path is where an old runtime's unscoped list is classified on this
 * client, so the evidence that classifies it has to be the answering authority's
 * own project table. A test that supplied its own context would pass while the
 * hook kept handing the desktop's table to every authority, so the only mocks
 * here are the transports.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import type { AppState } from '@/store'
import type { Repo } from '../../../../shared/repo-types'
import type { AutomationHostCatalogView } from './use-automation-host-catalog'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  callRuntimeRpc: vi.fn(),
  getRuntimeEnvironmentStatus: vi.fn()
}))

vi.mock('@/store', () => {
  const useAppStore = (selector: (state: Partial<AppState>) => unknown): unknown =>
    selector(mocks.state as Partial<AppState>)
  useAppStore.getState = (): Partial<AppState> => mocks.state as Partial<AppState>
  return { useAppStore }
})

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => mocks.callRuntimeRpc(...args),
  getRuntimeEnvironmentStatus: (...args: unknown[]) => mocks.getRuntimeEnvironmentStatus(...args),
  hasRuntimeRpcErrorCode: () => false
}))

import { useAutomationHostCatalog } from './use-automation-host-catalog'

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
  view = useAutomationHostCatalog()
  return null
}

async function renderCatalog(repos: readonly Repo[]): Promise<void> {
  mocks.state = storeState(repos)
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
  document.body.innerHTML = ''
})

describe('useAutomationHostCatalog orphan bootstrap', () => {
  it('projects the orphan entry a host answer reported', async () => {
    desktopListScoped.mockResolvedValue({ automations: [], items: [], orphanCount: 2 })

    await renderCatalog([])

    // Only a committed answer can report it, so the catalog has to re-derive on
    // the cache; nothing in the store changes when an orphan count arrives.
    expect(view?.catalog.entries.map((entry) => entry.stableKey)).toContain('host:desktop:orphan')
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
