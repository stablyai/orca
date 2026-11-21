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

function installing(
  phase: ManagedRuntimeOperation['phase'],
  downloadedBytes = 40_000_000,
  totalBytes: number | null = 100_000_000
): ManagedRuntimeInstallState {
  return {
    ...external(null),
    source: null,
    operation: { id: 'op-1', kind: 'install', phase, downloadedBytes, totalBytes }
  }
}

const viewOf = (state: ManagedRuntimeInstallState) =>
  managedRuntimeInstallView({ kind: 'known', state }, 'Antigravity')

describe('managedRuntimeInstallView with a host copy that runs', () => {
  it('offers no Install while Orca has no copy', () => {
    const view = viewOf(external(null))
    expect(view.status).not.toBeNull()
    expect(view.action).toBeNull()
    expect(view.menuAction).toBeNull()
    expect(view.removable).toBe(false)
  })

  it('keeps Remove once Orca has its copy, which the host copy still outranks', () => {
    const view = viewOf(external('1.5.0'))
    expect(view.action).toBeNull()
    expect(view.menuAction).toBeNull()
    expect(view.removable).toBe(true)
  })

  it('names the agent only for screen readers, since the row sits under it', () => {
    const view = viewOf(external(null))
    expect(view.status).not.toContain('Antigravity')
    expect(view.spokenStatus).toContain('Antigravity')
  })

  it("hides a failed install of Orca's copy, which wouldn't run anyway", () => {
    const view = viewOf({
      ...external(null),
      operation: {
        id: 'op-1',
        kind: 'install',
        phase: 'failed',
        downloadedBytes: 0,
        totalBytes: null,
        error: 'network down'
      }
    })
    expect(view.error).toBeNull()
    expect(view.action).toBeNull()
  })

  it('still shows a failed Remove, which the user asked for from this row', () => {
    const view = viewOf({
      ...external('1.5.0'),
      operation: {
        id: 'op-1',
        kind: 'remove',
        phase: 'failed',
        downloadedBytes: 0,
        totalBytes: null,
        error: 'file in use'
      }
    })
    expect(view.error).toBe('file in use')
  })
})

describe('managedRuntimeInstallView while installing', () => {
  it('shows a bar and no spinner while a download of known size runs', () => {
    const view = viewOf(installing('downloading'))
    expect(view.progress).toBe(40)
    expect(view.busy).toBe(false)
    expect(view.action?.kind).toBe('cancel')
  })

  it('shows an empty bar, not a spinner, before the first byte of a known size', () => {
    const view = viewOf(installing('downloading', 0, 100_000_000))
    expect(view.progress).toBe(0)
    expect(view.busy).toBe(false)
    expect(view.action?.kind).toBe('cancel')
  })

  it.each([null, 0])('spins with Cancel while a download has total %s', (totalBytes) => {
    const view = viewOf(installing('downloading', 40_000_000, totalBytes))
    expect(view.progress).toBeNull()
    expect(view.busy).toBe(true)
    expect(view.status).toContain('40.0')
    expect(view.action?.kind).toBe('cancel')
  })

  it.each(['extracting', 'verifying'] as const)('shows a spinner and Cancel while %s', (phase) => {
    const view = viewOf(installing(phase))
    expect(view.progress).toBeNull()
    expect(view.busy).toBe(true)
    expect(view.action?.kind).toBe('cancel')
  })

  it('names the agent only for screen readers while verifying', () => {
    const view = viewOf(installing('verifying'))
    expect(view.status).not.toContain('Antigravity')
    expect(view.spokenStatus).toContain('Antigravity')
  })

  it('has no separate spoken status while unpacking, whose copy names no agent either way', () => {
    expect(viewOf(installing('extracting')).spokenStatus).toBeNull()
  })
})

describe('managedRuntimeInstallView reasons', () => {
  it('lets an unavailable, damaged or outdated status wrap whole', () => {
    expect(
      viewOf({ ...external('1.4.0'), source: 'managed', installedCurrent: false }).reason
    ).toBe(true)
    expect(viewOf({ ...installing('downloading'), operation: null, available: false }).reason).toBe(
      true
    )
    expect(viewOf({ ...installing('downloading'), operation: null, damaged: true }).reason).toBe(
      true
    )
  })

  it('lets a short status truncate', () => {
    expect(viewOf(external(null)).reason).toBe(false)
    expect(viewOf(installing('verifying')).reason).toBe(false)
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
