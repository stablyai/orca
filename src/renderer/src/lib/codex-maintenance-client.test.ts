// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { codexCliInstallation } from '../../../shared/codex-cli-installation'
import {
  CODEX_MAINTENANCE_CAPABILITY,
  type CodexMaintenanceState
} from '../../../shared/codex-cli-maintenance'
import { callCodexMaintenance } from './codex-maintenance-client'
const { call, supports } = vi.hoisted(() => ({ call: vi.fn(), supports: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: call,
  runtimeEnvironmentSupportsCapability: supports
}))
afterEach(() => vi.clearAllMocks())
function ready(): CodexMaintenanceState {
  return {
    installation: codexCliInstallation(true, '0.136.0'),
    canRun: true,
    job: null
  }
}
describe('Codex maintenance renderer execution host', () => {
  it('uses the paired runtime only after that runtime advertises support', async () => {
    supports.mockResolvedValue(true)
    call.mockResolvedValue(ready())
    const target = { kind: 'environment', environmentId: 'remote-runtime' } as const
    expect(await callCodexMaintenance(target, { operation: 'status' })).toEqual(ready())
    expect(supports).toHaveBeenCalledWith('remote-runtime', CODEX_MAINTENANCE_CAPABILITY)
    expect(call).toHaveBeenCalledWith(target, 'preflight.codexMaintenance', { operation: 'status' })
  })
  it('allows unknown status on an old runtime and refuses its explicit start without dispatching', async () => {
    supports.mockResolvedValue(false)
    const target = { kind: 'environment', environmentId: 'old-runtime' } as const
    expect((await callCodexMaintenance(target, { operation: 'status' })).installation.status).toBe(
      'unknown'
    )
    await expect(callCodexMaintenance(target, { operation: 'start' })).rejects.toThrow(
      'does not support'
    )
    expect(call).not.toHaveBeenCalled()
  })
  it('keeps local maintenance on its explicit preload path', async () => {
    const maintenance = vi.fn().mockResolvedValue(ready())
    Object.assign(window, { api: { preflight: { codexMaintenance: maintenance } } })
    await callCodexMaintenance({ kind: 'local', cwd: '/project' }, { operation: 'start' })
    expect(maintenance.mock.calls).toEqual([[{ operation: 'start', cwd: '/project' }]])
    expect(call).not.toHaveBeenCalled()
  })
})
