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

function shown(patch: Partial<ManagedRuntimeInstallState>, surface: 'settings' | 'chat') {
  const view = managedRuntimeInstallView(
    { kind: 'known', state: { ...idle, ...patch } },
    'Fake',
    surface
  )
  return [view.status, view.action?.label ?? null, view.error]
}

describe('managedRuntimeInstallView', () => {
  it('says and offers what the host state allows on each surface', () => {
    const installed = {
      installedVersion: '1.3.0',
      installedCurrent: true,
      source: 'managed' as const
    }
    expect(shown({}, 'settings')).toEqual(['Not installed.', 'Install Fake', null])
    expect(shown({}, 'chat')).toEqual([null, 'Install Fake', null])
    expect(shown({ downloadBytes: 111_456_962 }, 'chat')).toEqual([
      '112 MB download.',
      'Install Fake',
      null
    ])
    expect(shown({ operation: op({}) }, 'chat')).toEqual([
      'Downloading 42.0 MB of 111.0 MB.',
      'Cancel installation',
      null
    ])
    expect(shown({ operation: op({ phase: 'verifying' }) }, 'settings')).toEqual([
      'Checking the downloaded runtime.',
      'Cancel installation',
      null
    ])
    // Only the row whose Cancel is still out says so; the host publishes no cancelling phase.
    const cancelling = managedRuntimeInstallView(
      { kind: 'known', state: { ...idle, operation: op({}) } },
      'Fake',
      'chat',
      true
    )
    expect(cancelling.status).toBe('Cancelling…')
    expect(shown({ operation: op({ phase: 'cancelled' }) }, 'chat')).toEqual([
      'Installation cancelled.',
      'Retry installation',
      null
    ])
    expect(
      shown({ operation: op({ phase: 'failed', error: 'No space left.' }) }, 'settings')
    ).toEqual(['Not installed.', 'Retry installation', 'No space left.'])
    expect(shown(installed, 'settings')).toEqual(['Installed.', 'Reinstall Fake', null])
    expect(
      shown({ ...installed, installedVersion: '1.2.0', installedCurrent: false }, 'settings')
    ).toEqual(['Installed.', 'Update Fake', null])
    expect(shown(installed, 'chat')[1]).toBeNull()
    const removal = (patch: Partial<ManagedRuntimeOperation>, surface: 'settings' | 'chat') =>
      managedRuntimeInstallView(
        {
          kind: 'known',
          state: {
            ...idle,
            ...installed,
            canRemove: true,
            operation: op({ kind: 'remove', ...patch })
          }
        },
        'Fake',
        surface
      )
    expect(removal({ phase: 'removing' }, 'settings')).toMatchObject({
      status: 'Removing…',
      action: null,
      removable: false
    })
    // A refused removal keeps the files, so Remove stays offered beside the host's reason.
    expect(
      removal({ phase: 'failed', error: 'Fake could not be stopped.' }, 'settings')
    ).toMatchObject({
      status: 'Installed.',
      error: 'Fake could not be stopped.',
      removable: true
    })
    expect(removal({ phase: 'succeeded' }, 'chat').removable).toBe(false)
    // A damaged copy is removable too, so a broken install never leaves Settings without an exit.
    const damaged = { kind: 'known' as const, state: { ...idle, damaged: true, canRemove: true } }
    expect(managedRuntimeInstallView(damaged, 'Fake', 'settings').removable).toBe(true)
    expect(shown({ available: false, version: null }, 'settings')).toEqual([
      'Fake is not available on this host.',
      null,
      null
    ])
    expect(shown({ damaged: true }, 'chat')).toEqual([
      'This copy of Fake is damaged.',
      'Install Fake',
      null
    ])
    const external = { source: 'external' as const }
    expect(shown(external, 'settings')).toEqual([
      'Uses the copy of Fake found on this host.',
      "Install Orca's copy",
      null
    ])
    expect(shown(external, 'chat')[1]).toBeNull()
  })

  it('never reads a failed status read as not installed', () => {
    const view = managedRuntimeInstallView({ kind: 'readFailed' }, 'Fake', 'chat')
    expect(view.action).toBeNull()
    expect(view.error).toBe('Could not check Fake on this host. Retrying.')
  })
})
