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

const viewOf = (patch: Partial<ManagedRuntimeInstallState>) =>
  managedRuntimeInstallView({ kind: 'known', state: { ...idle, ...patch } }, 'Fake')

function shown(patch: Partial<ManagedRuntimeInstallState>) {
  const view = viewOf(patch)
  return [view.status, view.action?.label ?? null, view.error, view.note]
}

describe('managedRuntimeInstallView', () => {
  it('says and offers what the host state allows', () => {
    const installed = {
      installedVersion: '1.3.0',
      installedCurrent: true,
      source: 'managed' as const
    }
    expect(shown({})).toEqual(['Not installed.', 'Install', null, null])
    expect(managedRuntimeInstallView({ kind: 'known', state: idle }, 'Fake').prominent).toBe(true)
    expect(shown({ downloadBytes: 111_456_962 })).toEqual([
      'Not installed.',
      'Install',
      null,
      '112 MB download.'
    ])
    expect(shown({ operation: op({}) })).toEqual([
      'Downloading 42.0 MB of 111.0 MB.',
      'Cancel',
      null,
      null
    ])
    expect(shown({ operation: op({ phase: 'verifying' }) })).toEqual([
      'Checking the downloaded runtime.',
      'Cancel',
      null,
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
      'Try again',
      null,
      null
    ])
    // A failed install says only why, beside Try again.
    expect(shown({ operation: op({ phase: 'failed', error: 'No space left.' }) })).toEqual([
      null,
      'Try again',
      'No space left.',
      null
    ])
    // An installed copy's line says only that; Reinstall or Update and Remove sit in its menu.
    expect(shown(installed)).toEqual(['Installed', null, null, null])
    expect(viewOf({ ...installed, canRemove: true })).toMatchObject({
      removable: true,
      menuAction: { kind: 'install', label: 'Reinstall Fake' }
    })
    const update = viewOf({ ...installed, installedVersion: '1.2.0', installedCurrent: false })
    expect(update).toMatchObject({
      status: 'Installed',
      action: null,
      menuAction: { label: 'Update' }
    })
    const removal = (patch: Partial<ManagedRuntimeOperation>) =>
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
        'Fake'
      )
    expect(removal({ phase: 'removing' })).toMatchObject({
      status: 'Removing…',
      action: null,
      removable: false,
      removing: true
    })
    // A refused removal keeps the files, so Remove stays offered beside the host's reason.
    expect(removal({ phase: 'failed', error: 'Fake could not be stopped.' })).toMatchObject({
      status: 'Installed',
      error: 'Fake could not be stopped.',
      removable: true
    })
    // A damaged copy is removable too, so a broken install never leaves Settings without an exit.
    const damaged = { kind: 'known' as const, state: { ...idle, damaged: true, canRemove: true } }
    expect(managedRuntimeInstallView(damaged, 'Fake').removable).toBe(true)
    expect(shown({ available: false, version: null })).toEqual([
      'Fake is not available on this host.',
      null,
      null,
      null
    ])
    expect(viewOf({ damaged: true })).toMatchObject({
      status: 'This copy of Fake is damaged.',
      action: { label: 'Reinstall' },
      prominent: true,
      menuAction: null
    })
    const external = { source: 'external' as const }
    expect(shown(external)).toEqual([
      'Uses the copy of Fake found on this host.',
      "Install Orca's copy",
      null,
      null
    ])
  })

  it('never reads a failed status read as not installed', () => {
    const view = managedRuntimeInstallView({ kind: 'readFailed' }, 'Fake')
    expect(view.action).toBeNull()
    expect(view.error).toBe('Could not check Fake on this host. Retrying.')
  })
})
