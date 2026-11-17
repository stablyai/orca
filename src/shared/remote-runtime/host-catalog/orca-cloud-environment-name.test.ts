import { describe, expect, it } from 'vitest'
import {
  legacyOrcaCloudEnvironmentName,
  orcaCloudEnvironmentName,
  runtimeEnvironmentDisplayName
} from './orca-cloud-environment-name'
import { buildExecutionHostRegistry } from '../../execution-host/execution-host-registry'

const RUNTIME_ID = '6f1c2a9e-0b4d-4c11-9a3e-7d2f22b5b1e7'

describe('Orca Cloud server names', () => {
  it('shows a cloud sandbox as Orca Cloud, never its id tail', () => {
    const name = orcaCloudEnvironmentName('repo', RUNTIME_ID)
    expect(name).toBe('repo sandbox 22b5b1e7')
    expect(runtimeEnvironmentDisplayName({ name, source: 'ephemeral-vm' })).toBe('Orca Cloud')
  })

  it('leaves custom recipe VMs and user-named servers alone', () => {
    expect(
      runtimeEnvironmentDisplayName({ name: 'repo VM 22b5b1e7', source: 'ephemeral-vm' })
    ).toBe('repo VM 22b5b1e7')
    expect(runtimeEnvironmentDisplayName({ name: 'repo sandbox 22b5b1e7', source: 'manual' })).toBe(
      'repo sandbox 22b5b1e7'
    )
  })

  it('renames only the legacy name built from this runtime', () => {
    expect(legacyOrcaCloudEnvironmentName('repo VM 22b5b1e7', RUNTIME_ID)).toBe(
      'repo sandbox 22b5b1e7'
    )
    expect(legacyOrcaCloudEnvironmentName('repo VM 00000000', RUNTIME_ID)).toBeNull()
    expect(legacyOrcaCloudEnvironmentName(' VM 22b5b1e7', RUNTIME_ID)).toBeNull()
  })

  it('labels the sidebar host Orca Cloud', () => {
    const hosts = buildExecutionHostRegistry({
      repos: [],
      settings: null,
      runtimeEnvironments: [
        { id: 'env-1', name: 'repo sandbox 22b5b1e7', source: 'ephemeral-vm' },
        { id: 'env-2', name: 'build box', source: 'manual' }
      ]
    })
    const labels = Object.fromEntries(hosts.map((host) => [host.id, host.label]))
    expect(labels['runtime:env-1']).toBe('Orca Cloud')
    expect(labels['runtime:env-2']).toBe('build box')
  })
})
