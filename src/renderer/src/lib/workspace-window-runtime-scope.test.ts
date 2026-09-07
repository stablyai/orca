import { afterEach, expect, it, vi } from 'vitest'
import { isLocalPathOpenBlocked } from './local-path-open-guard'
import { noteWorkspaceWindowRuntimeEnvironment } from './workspace-window-runtime-scope'

afterEach(() => vi.unstubAllGlobals())
it('allows the window local runtime without treating another paired host as local', () => {
  vi.stubGlobal('window', { orcaWorkspaceWindowNative: { localRuntimeId: 'local' } })
  noteWorkspaceWindowRuntimeEnvironment('loopback-env', 'local')
  noteWorkspaceWindowRuntimeEnvironment('remote-env', 'foreign')
  expect(isLocalPathOpenBlocked({ activeRuntimeEnvironmentId: 'loopback-env' })).toBe(false)
  expect(isLocalPathOpenBlocked({ activeRuntimeEnvironmentId: 'remote-env' })).toBe(true)
  expect(
    isLocalPathOpenBlocked({ activeRuntimeEnvironmentId: 'loopback-env' }, { connectionId: 'ssh' })
  ).toBe(true)
})
