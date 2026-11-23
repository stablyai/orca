import { expect, it } from 'vitest'
import type { ManagedRuntimeInstallState } from '../../../../shared/agent-launch/installation/managed-runtime-install'
import { managedRuntimeInstallView } from './managed-runtime-install-view'

const t = (_key: string, fallback: string, values?: Record<string, unknown>) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''))

function view(state: Partial<ManagedRuntimeInstallState>) {
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

it('leaves Update out while an automatic update is pending, and names the update in the menu', () => {
  const pending = view({ updatesAutomatically: true })
  expect(pending.action).toBeNull()
  expect(pending.status).toBe('Installed by Orca · 1.5.0')
  expect(pending.menuAction).toMatchObject({ kind: 'install', label: 'Update to 1.5.2' })
})

it('offers a prominent Update when no automatic update will run', () => {
  const offered = view({})
  expect(offered.action).toMatchObject({ kind: 'install', label: 'Update' })
  expect(offered.prominent).toBe(true)
})

it('keeps Reinstall in the menu for a current copy kept up to date', () => {
  const current = view({
    updatesAutomatically: true,
    installedVersion: '1.5.2',
    installedCurrent: true
  })
  expect(current.menuAction).toMatchObject({ label: 'Reinstall Antigravity' })
})
