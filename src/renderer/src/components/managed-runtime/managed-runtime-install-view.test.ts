import { describe, expect, it } from 'vitest'
import type {
  ManagedRuntimeInstallState,
  ManagedRuntimeOperation
} from '../../../../shared/managed-runtime-install'
import { managedRuntimeInstallView } from './managed-runtime-install-view'

const idle: ManagedRuntimeInstallState = {
  agent: 'fake',
  revision: 1,
  available: true,
  version: '1.3.0',
  installedVersion: null,
  installedCurrent: false,
  source: null,
  operation: null
}

const op = (patch: Partial<ManagedRuntimeOperation>): ManagedRuntimeOperation => ({
  id: 'op-1',
  kind: 'install',
  phase: 'downloading',
  downloadedBytes: 42_000_000,
  totalBytes: 111_000_000,
  ...patch
})

function shown(patch: Partial<ManagedRuntimeInstallState>) {
  const view = managedRuntimeInstallView({ kind: 'known', state: { ...idle, ...patch } }, 'Fake')
  return [view.status, view.action?.label ?? null, view.error]
}

describe('managedRuntimeInstallView', () => {
  it('says and offers what the host state allows', () => {
    const installed = {
      installedVersion: '1.3.0',
      installedCurrent: true,
      source: 'managed' as const
    }
    expect(shown({})).toEqual(['Not installed.', 'Install Fake', null])
    expect(shown({ downloadBytes: 111_456_962 })).toEqual([
      '112 MB download.',
      'Install Fake',
      null
    ])
    expect(shown({ operation: op({}) })).toEqual([
      'Downloading 42.0 MB of 111.0 MB.',
      'Cancel installation',
      null
    ])
    expect(shown({ operation: op({ phase: 'verifying' }) })).toEqual([
      'Checking the downloaded runtime.',
      'Cancel installation',
      null
    ])
    // Only the row whose Cancel is still out says so; the host publishes no cancelling phase.
    const cancelling = managedRuntimeInstallView(
      { kind: 'known', state: { ...idle, operation: op({}) } },
      'Fake',
      true
    )
    expect(cancelling.status).toBe('Cancelling…')
    expect(shown({ operation: op({ phase: 'cancelled' }) })).toEqual([
      'Installation cancelled.',
      'Retry installation',
      null
    ])
    expect(shown({ operation: op({ phase: 'failed', error: 'No space left.' }) })).toEqual([
      'Not installed.',
      'Retry installation',
      'No space left.'
    ])
    expect(shown(installed)).toEqual(['Installed.', 'Reinstall Fake', null])
    expect(shown({ ...installed, installedVersion: '1.2.0', installedCurrent: false })).toEqual([
      'Installed.',
      'Update Fake',
      null
    ])
    expect(shown({ available: false, version: null })).toEqual([
      'Fake is not available on this host.',
      null,
      null
    ])
    expect(shown({ damaged: true })).toEqual([
      'This copy of Fake is damaged.',
      'Install Fake',
      null
    ])
    const external = { source: 'external' as const }
    expect(shown(external)).toEqual([
      'Uses the copy of Fake found on this host.',
      "Install Orca's copy",
      null
    ])
  })

  it('never reads a failed status read as not installed', () => {
    const view = managedRuntimeInstallView({ kind: 'readFailed' }, 'Fake')
    expect(view.action).toBeNull()
    expect(view.error).toBe('Could not check Fake on this host. Retrying.')
  })
})
