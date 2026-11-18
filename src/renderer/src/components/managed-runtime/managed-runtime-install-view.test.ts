import { describe, expect, it } from 'vitest'
import type { ManagedRuntimeInstallState } from '../../../../shared/agent-launch/installation/managed-runtime-install'
import { managedRuntimeInstallView } from './managed-runtime-install-view'

function external(installedVersion: string | null): ManagedRuntimeInstallState {
  return {
    agent: 'antigravity',
    revision: 1,
    available: true,
    version: '1.5.0',
    installedVersion,
    installedCurrent: installedVersion !== null,
    canRemove: installedVersion !== null,
    source: 'external',
    operation: null
  }
}

describe('managedRuntimeInstallView with a host copy that runs', () => {
  it('offers Install while Orca has no copy', () => {
    const view = managedRuntimeInstallView({ kind: 'known', state: external(null) }, 'Antigravity')
    expect(view.action?.kind).toBe('install')
  })

  it('offers no Install once Orca has its copy, which the host copy still outranks', () => {
    const view = managedRuntimeInstallView(
      { kind: 'known', state: external('1.5.0') },
      'Antigravity'
    )
    expect(view.action).toBeNull()
    expect(view.removable).toBe(true)
  })
})
