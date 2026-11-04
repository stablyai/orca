import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostRegistryEntry } from '../../../../../../shared/execution-host-registry'
import { PROJECT_HOST_SETUP_RUNTIME_CAPABILITY } from '../../../../../../shared/worktree-runtime-capabilities'
import { buildSetupHostOptions } from './repository-host-setup-options'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

function runtimeHost(
  overrides: Partial<ExecutionHostRegistryEntry> = {}
): ExecutionHostRegistryEntry {
  return {
    id: 'runtime:env-1',
    kind: 'runtime',
    label: 'Remote Orca',
    detail: 'Orca server',
    health: 'available',
    ...overrides
  } as ExecutionHostRegistryEntry
}

describe('buildSetupHostOptions', () => {
  it('disables runtime hosts while capabilities are unknown', () => {
    expect(
      buildSetupHostOptions({
        projectHostSetups: [],
        hostOptions: [runtimeHost()]
      })[0]
    ).toMatchObject({
      isAvailable: false,
      detail: 'Checking host capabilities'
    })
  })

  it('disables runtime hosts that cannot run workspaces with explicit host context', () => {
    expect(
      buildSetupHostOptions({
        projectHostSetups: [],
        hostOptions: [
          runtimeHost({
            capabilities: [PROJECT_HOST_SETUP_RUNTIME_CAPABILITY]
          })
        ]
      })[0]
    ).toMatchObject({
      isAvailable: false,
      detail: 'Update Orca on this host to set up projects'
    })
  })
})
