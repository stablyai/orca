import { describe, expect, it } from 'vitest'
import type {
  ManagedRuntimeInstallState,
  ManagedRuntimeOperation
} from '../../../../shared/agent-launch/installation/managed-runtime-install'
import { managedRuntimeInstallView } from './managed-runtime-install-view'

const t = (_key: string, fallback: string, values?: Record<string, unknown>) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''))

function managedView(state: Partial<ManagedRuntimeInstallState>) {
  const full: ManagedRuntimeInstallState = {
    agent: 'antigravity',
    program: 'server',
    revision: 1,
    available: true,
    version: '1.5.2',
    installedVersion: '1.5.0',
    installedCurrent: false,
    source: 'managed',
    operation: null,
    ...state
  }
  return managedRuntimeInstallView({ kind: 'known', state: full }, 'Antigravity', false, t)
}

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

function installing(phase: ManagedRuntimeOperation['phase']): ManagedRuntimeInstallState {
  return {
    ...external(null),
    source: null,
    operation: {
      id: 'op-1',
      kind: 'install',
      phase,
      downloadedBytes: 40_000_000,
      totalBytes: 100_000_000
    }
  }
}

describe('managedRuntimeInstallView with a host copy that runs', () => {
  it('says the host copy runs and offers no Install while Orca has no copy', () => {
    const view = managedRuntimeInstallView({ kind: 'known', state: external(null) }, 'Antigravity')
    expect(view.status).toBe('Uses your own Antigravity')
    expect(view.action).toBeNull()
    expect(view.menuAction).toBeNull()
    expect(view.removable).toBe(false)
  })

  it('keeps Remove once Orca has its copy, which the host copy still outranks', () => {
    const view = managedRuntimeInstallView(
      { kind: 'known', state: external('1.5.0') },
      'Antigravity'
    )
    expect(view.status).toBe('Uses your own Antigravity')
    expect(view.action).toBeNull()
    expect(view.menuAction).toBeNull()
    expect(view.removable).toBe(true)
  })
})

describe('managedRuntimeInstallView while installing', () => {
  it('shows progress and no spinner while downloading', () => {
    const view = managedRuntimeInstallView(
      { kind: 'known', state: installing('downloading') },
      'Antigravity'
    )
    expect(view.status).toBe('Downloading 40.0 MB of 100.0 MB.')
    expect(view.progress).toBe(40)
    expect(view.busy).toBe(false)
    expect(view.action?.kind).toBe('cancel')
  })

  it.each([
    ['extracting', 'Unpacking…'],
    ['verifying', 'Verifying Antigravity…']
  ] as const)('shows a spinner and Cancel while %s', (phase, status) => {
    const view = managedRuntimeInstallView(
      { kind: 'known', state: installing(phase) },
      'Antigravity'
    )
    expect(view.status).toBe(status)
    expect(view.progress).toBeNull()
    expect(view.busy).toBe(true)
    expect(view.action?.kind).toBe('cancel')
  })
})

describe("managedRuntimeInstallView with Orca's copy", () => {
  it('leaves Update out while an automatic update is pending, and names the update in the menu', () => {
    const pending = managedView({ updatesAutomatically: true })
    expect(pending.action).toBeNull()
    expect(pending.status).toBe('Installed by Orca · 1.5.0')
    expect(pending.menuAction).toMatchObject({ kind: 'install', label: 'Update to 1.5.2' })
  })

  it('offers a prominent Update when no automatic update will run', () => {
    const offered = managedView({})
    expect(offered.action).toMatchObject({ kind: 'install', label: 'Update' })
    expect(offered.prominent).toBe(true)
  })

  it('keeps Reinstall in the menu for a current copy kept up to date', () => {
    const current = managedView({
      updatesAutomatically: true,
      installedVersion: '1.5.2',
      installedCurrent: true
    })
    expect(current.menuAction).toMatchObject({ label: 'Reinstall Antigravity' })
  })
})
