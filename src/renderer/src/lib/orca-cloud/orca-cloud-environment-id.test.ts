import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'

const crumbs = vi.hoisted(() => {
  const value: { recorded: { name: string; data: unknown }[] } = { recorded: [] }
  return value
})
vi.mock('@/diagnostics/crash-reporting/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: (name: string, data: unknown) =>
    crumbs.recorded.push({ name, data })
}))
import {
  isOrcaCloudEnvironmentForLaunch,
  isOrcaCloudExecutionHostId
} from './orca-cloud-environment-id'

const initial = useAppStore.getState().runtimeEnvironments

afterEach(() => {
  useAppStore.setState({ runtimeEnvironments: initial })
  vi.unstubAllGlobals()
})

function stubMain(
  isCloudEnvironment: (request: { runtimeEnvironmentId: string }) => Promise<boolean>
) {
  const spy = vi.fn(isCloudEnvironment)
  vi.stubGlobal('window', { api: { orcaCloudAgents: { isCloudEnvironment: spy } } })
  return spy
}

describe('isOrcaCloudExecutionHostId', () => {
  it('names a cloud create a workspace: only an Orca Cloud runtime counts', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only id, name and source
    const runtimeEnvironments = [
      { id: 'env-cloud', name: 'Hello-World sandbox abcd1234', source: 'ephemeral-vm' },
      { id: 'env-server', name: 'Dev server', source: 'manual' }
    ] as unknown as ReturnType<typeof useAppStore.getState>['runtimeEnvironments']
    useAppStore.setState({ runtimeEnvironments })
    expect(isOrcaCloudExecutionHostId('runtime:env-cloud')).toBe(true)
    expect(isOrcaCloudExecutionHostId('runtime:env-server')).toBe(false)
    expect(isOrcaCloudExecutionHostId('local')).toBe(false)
    expect(isOrcaCloudExecutionHostId('ssh:devbox')).toBe(false)
    expect(isOrcaCloudExecutionHostId(null)).toBe(false)
  })
})

describe('isOrcaCloudEnvironmentForLaunch (FAIL-CLOSED, #568)', () => {
  it('a fresh pairing whose catalog flag has not arrived yet is still Orca Cloud (main says so)', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only id, name and source
    const runtimeEnvironments = [
      { id: 'env-paired', name: 'orca-sandbox-push-test (cloud)', source: 'manual' }
    ] as unknown as ReturnType<typeof useAppStore.getState>['runtimeEnvironments']
    useAppStore.setState({ runtimeEnvironments })
    const main = stubMain(async ({ runtimeEnvironmentId }) => runtimeEnvironmentId === 'env-paired')
    expect(await isOrcaCloudEnvironmentForLaunch('env-paired')).toBe(true)
    expect(await isOrcaCloudEnvironmentForLaunch('env-not-in-store-yet')).toBe(false)
    expect(main).toHaveBeenCalledTimes(2)
  })

  it('the catalog flag answers without asking main; a server main does not know stays non-cloud', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only id, name and source
    const runtimeEnvironments = [
      { id: 'env-flagged', name: 'x (cloud)', source: 'manual', orcaCloudPaired: true },
      { id: 'env-server', name: 'Dev server', source: 'manual' }
    ] as unknown as ReturnType<typeof useAppStore.getState>['runtimeEnvironments']
    useAppStore.setState({ runtimeEnvironments })
    const main = stubMain(async () => false)
    expect(await isOrcaCloudEnvironmentForLaunch('env-flagged')).toBe(true)
    expect(main).not.toHaveBeenCalled()
    expect(await isOrcaCloudEnvironmentForLaunch('env-server')).toBe(false)
  })
})

describe('isOrcaCloudEnvironmentForLaunch when main cannot answer', () => {
  it('a thrown confirm warns, leaves a breadcrumb, and returns false (kept open, logged)', async () => {
    useAppStore.setState({ runtimeEnvironments: [] })
    stubMain(async () => {
      throw new Error('ipc gone')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    crumbs.recorded = []
    expect(await isOrcaCloudEnvironmentForLaunch('env-x')).toBe(false)
    expect(warn).toHaveBeenCalledWith(
      '[orca-cloud] cloud-host confirm failed; launching unheld',
      expect.any(Error)
    )
    expect(crumbs.recorded).toEqual([
      { name: 'cloud-host confirm failed; launching unheld', data: { environmentId: 'env-x' } }
    ])
    warn.mockRestore()
  })
})
