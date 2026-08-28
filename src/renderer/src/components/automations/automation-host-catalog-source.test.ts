import { describe, expect, it } from 'vitest'
import { AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  buildAutomationHostCatalogSource,
  runtimeAuthorityHealth,
  runtimeQuerySupport,
  type AutomationCatalogRuntimeSource,
  type AutomationCatalogSshSource
} from './automation-host-catalog-source'

function runtime(
  overrides: Partial<AutomationCatalogRuntimeSource> = {}
): AutomationCatalogRuntimeSource {
  return {
    environmentId: 'gpu',
    label: 'GPU box',
    pairingRevision: 7,
    status: undefined,
    ssh: undefined,
    ...overrides
  }
}

const EMPTY_SSH: AutomationCatalogSshSource = {
  targetsHydrated: true,
  targetLabels: new Map(),
  removedTargetLabels: new Map(),
  connectionStates: new Map()
}

describe('automation host catalog source', () => {
  it('treats a never-probed environment as loading, not as down', () => {
    expect(runtimeAuthorityHealth(runtime())).toBe('loading')
    expect(runtimeAuthorityHealth(runtime({ status: { status: null } }))).toBe('unavailable')
    expect(runtimeAuthorityHealth(runtime({ status: { status: {} as never } }))).toBe('fresh')
  })

  it('assumes scoped support until the capability set is actually known', () => {
    // The scoped client re-checks the capability and fails closed itself, so
    // guessing legacy here would only discard owners on a modern host.
    expect(runtimeQuerySupport(runtime())).toBe('scoped')
    expect(runtimeQuerySupport(runtime({ status: { status: null } }))).toBe('scoped')
    expect(
      runtimeQuerySupport(runtime({ status: { status: { capabilities: [] } as never } }))
    ).toBe('legacy-unscoped')
    expect(
      runtimeQuerySupport(
        runtime({
          status: {
            status: { capabilities: [AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY] } as never
          }
        })
      )
    ).toBe('scoped')
  })

  it('assumes a hydrated desktop target with no recorded state is disconnected', () => {
    const input = buildAutomationHostCatalogSource({
      desktopSsh: {
        ...EMPTY_SSH,
        targetLabels: new Map([['t1', 'web-01']]),
        targetGenerations: new Map([['t1', 3]])
      },
      runtimes: [],
      runtimeCatalogSettled: true
    })

    expect(input.desktop.ssh.missingConnectionStatus).toBe('disconnected')
    expect(input.desktop.ssh.targets).toEqual([{ targetId: 't1', label: 'web-01', generation: 3 }])
  })

  it('omits a generation the authority never reported rather than inventing one', () => {
    const input = buildAutomationHostCatalogSource({
      desktopSsh: { ...EMPTY_SSH, targetLabels: new Map([['t1', 'web-01']]) },
      runtimes: [],
      runtimeCatalogSettled: true
    })

    expect(input.desktop.ssh.targets[0]).toEqual({ targetId: 't1', label: 'web-01' })
  })

  it('omits an unsettled orphan count instead of passing zero', () => {
    const settled = buildAutomationHostCatalogSource({
      desktopSsh: EMPTY_SSH,
      runtimes: [],
      runtimeCatalogSettled: true,
      orphanCount: () => 0
    })
    const unsettled = buildAutomationHostCatalogSource({
      desktopSsh: EMPTY_SSH,
      runtimes: [],
      runtimeCatalogSettled: true,
      orphanCount: () => null
    })

    expect(settled.desktop.orphanCount).toBe(0)
    expect('orphanCount' in unsettled.desktop).toBe(false)
  })

  it('leaves a runtime with no mirrored SSH state unhydrated', () => {
    const input = buildAutomationHostCatalogSource({
      desktopSsh: EMPTY_SSH,
      runtimes: [runtime()],
      runtimeCatalogSettled: true
    })

    // Absence of a bucket is not evidence the environment has no targets.
    expect(input.runtimes[0].ssh.targetsHydrated).toBe(false)
    expect(input.runtimes[0].pairingRevision).toBe(7)
  })
})
