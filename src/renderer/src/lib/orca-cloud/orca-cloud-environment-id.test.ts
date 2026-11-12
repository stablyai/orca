import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store/index'
import { isOrcaCloudExecutionHostId } from './orca-cloud-environment-id'

const initial = useAppStore.getState().runtimeEnvironments

afterEach(() => {
  useAppStore.setState({ runtimeEnvironments: initial })
})

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
