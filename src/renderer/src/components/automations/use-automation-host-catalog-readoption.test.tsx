// @vitest-environment happy-dom

/**
 * Same-id SSH re-adoption on the desktop authority.
 *
 * This is the one catalog change that alters nothing the apply policy used to
 * look at: the stable key is incarnation-free, the state stays authoritative,
 * the query support stays scoped, the owner stays present and the host stays up
 * — only the registration generation moves. The desktop's connection generation
 * is a constant and can never reject anything either, so if the apply does not
 * run, rows fetched against the previous registration both render and become the
 * captured owners that fence later mutations.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import type { AutomationListScopeSelector } from '../../../../shared/automation-list-scope'
import type { AppState } from '@/store'
import type { AutomationHostCatalogView } from './use-automation-host-catalog'
import { resetAutomationHostCatalogGenerationsForTests } from './automation-host-catalog-generation'

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))

vi.mock('@/store', () => {
  const useAppStore = (selector: (state: Partial<AppState>) => unknown): unknown =>
    selector(mocks.state as Partial<AppState>)
  useAppStore.getState = (): Partial<AppState> => mocks.state as Partial<AppState>
  return { useAppStore }
})

// Desktop-only file: every request is a local-target scoped list, so the
// transport routes straight into the generation-aware fake below.
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (_target: unknown, _method: string, params: unknown) =>
    listScoped(params as { selector: AutomationListScopeSelector }),
  getRuntimeEnvironmentStatus: vi.fn(),
  hasRuntimeRpcErrorCode: () => false
}))

import { useAutomationHostCatalog } from './use-automation-host-catalog'

const TARGET_ID = 'ssh-1'
const SSH_STABLE_KEY = `host:desktop:ssh:${TARGET_ID}`
const DESKTOP_AUTHORITY_KEY = 'authority:desktop'

function storeState(targetGeneration: number): Record<string, unknown> {
  const noop = (): void => undefined
  return {
    repos: [],
    settings: null,
    sshConnectionStates: new Map([[TARGET_ID, { status: 'connected' }]]),
    sshTargetLabels: new Map([[TARGET_ID, 'Build box']]),
    sshTargetGenerations: new Map([[TARGET_ID, targetGeneration]]),
    removedSshTargetLabels: new Map(),
    sshTargetsHydrated: true,
    sshStateByEnvironment: new Map(),
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogSettled: true,
    runtimeStatusByEnvironmentId: new Map(),
    automationHostFilter: { kind: 'all' },
    setAutomationHostFilter: noop,
    openSettingsPage: noop,
    openSettingsTarget: noop
  }
}

/** One row per registration generation, so a displayed row names the incarnation it came from. */
function scopedResponse(selector: AutomationListScopeSelector): unknown {
  if (selector.kind !== 'ssh') {
    return { automations: [], items: [], orphanCount: 0 }
  }
  const id = `a-gen${selector.expectedTargetGeneration}`
  return {
    automations: [{ id, name: id } as Automation],
    items: [
      {
        automationId: id,
        selector: {
          kind: 'ssh',
          targetId: selector.targetId,
          targetGeneration: selector.expectedTargetGeneration
        }
      }
    ],
    orphanCount: 0
  }
}

const scopeRequests: AutomationListScopeSelector[] = []
/** Generation whose answer is held in flight; null lets every request answer at once. */
let heldGeneration: number | null = null
let releaseHeld: (() => void) | null = null

function listScoped({ selector }: { selector: AutomationListScopeSelector }): Promise<unknown> {
  scopeRequests.push(selector)
  if (selector.kind === 'ssh' && selector.expectedTargetGeneration === heldGeneration) {
    return new Promise<unknown>((resolve) => {
      releaseHeld = () => resolve(scopedResponse(selector))
    })
  }
  return Promise.resolve(scopedResponse(selector))
}

const roots: Root[] = []
let root: Root | null = null
let view: AutomationHostCatalogView | null = null

function Harness(): null {
  view = useAutomationHostCatalog()
  return null
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index++) {
      await Promise.resolve()
    }
  })
}

async function renderWithGeneration(targetGeneration: number): Promise<void> {
  mocks.state = storeState(targetGeneration)
  if (!root) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    roots.push(root)
  }
  const current = root
  await act(async () => {
    current.render(<Harness />)
  })
  await flush()
}

function sshRequestGenerations(): number[] {
  return scopeRequests
    .filter((selector) => selector.kind === 'ssh')
    .map((selector) => (selector as { expectedTargetGeneration: number }).expectedTargetGeneration)
}

function sshHostAutomationIds(): string[] {
  const group = view?.rows.groups.find((entry) => entry.authorityKey === DESKTOP_AUTHORITY_KEY)
  const host = group?.hosts.find((candidate) => candidate.entry.stableKey === SSH_STABLE_KEY)
  return (host?.rows ?? []).map((row) => row.automation.id)
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  resetAutomationHostCatalogGenerationsForTests()
  view = null
  root = null
  scopeRequests.length = 0
  heldGeneration = null
  releaseHeld = null
  Object.assign(window, {
    api: {
      ssh: { connect: vi.fn() },
      runtimeEnvironments: { connect: vi.fn() }
    }
  })
})

afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((item) => item.unmount())
  })
  document.body.innerHTML = ''
})

describe('useAutomationHostCatalog same-id SSH re-adoption', () => {
  it('discards a scoped answer captured before the re-adoption', async () => {
    heldGeneration = 4
    await renderWithGeneration(4)
    expect(sshRequestGenerations()).toEqual([4])

    await renderWithGeneration(5)
    heldGeneration = null
    releaseHeld?.()
    await flush()

    expect(sshHostAutomationIds()).not.toContain('a-gen4')
    expect(sshHostAutomationIds()).toEqual(['a-gen5'])
  })

  it('re-fetches the re-adopted host inside the cache TTL', async () => {
    await renderWithGeneration(4)
    expect(sshHostAutomationIds()).toEqual(['a-gen4'])

    await renderWithGeneration(5)

    expect(sshRequestGenerations()).toEqual([4, 5])
    expect(sshHostAutomationIds()).toEqual(['a-gen5'])
  })

  it('does not keep the previous registration’s rows on screen while the re-fetch runs', async () => {
    await renderWithGeneration(4)
    expect(sshHostAutomationIds()).toEqual(['a-gen4'])

    heldGeneration = 5
    await renderWithGeneration(5)

    expect(sshHostAutomationIds()).toEqual([])
  })
})
