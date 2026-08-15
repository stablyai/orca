import { describe, expect, it } from 'vitest'
import {
  buildRuntimeClientEventEnvironmentKey,
  getNewlyConnectedRuntimeEnvironmentIds,
  getNewlyDisconnectedRuntimeEnvironmentIds,
  getRuntimeProjectRefreshEnvironmentIds
} from './useIpcEvents'

describe('buildRuntimeClientEventEnvironmentKey', () => {
  it('treats runtime environment ids as a stable set', () => {
    expect(buildRuntimeClientEventEnvironmentKey(['env-b', 'env-a', 'env-b'])).toBe(
      buildRuntimeClientEventEnvironmentKey(['env-a', 'env-b'])
    )
  })
})

describe('getNewlyConnectedRuntimeEnvironmentIds', () => {
  it('returns only environments that became connected', () => {
    expect(getNewlyConnectedRuntimeEnvironmentIds(['env-a'], ['env-a', 'env-b'])).toEqual(['env-b'])
  })

  it('ignores environments that disconnected or stayed connected', () => {
    expect(getNewlyConnectedRuntimeEnvironmentIds(['env-a', 'env-b'], ['env-a'])).toEqual([])
  })

  it('treats every environment as new when none were connected before', () => {
    expect(getNewlyConnectedRuntimeEnvironmentIds([], ['env-a', 'env-a', 'env-b'])).toEqual([
      'env-a',
      'env-b'
    ])
  })
})

describe('getNewlyDisconnectedRuntimeEnvironmentIds', () => {
  it('returns only environments whose transport was just observed down', () => {
    expect(getNewlyDisconnectedRuntimeEnvironmentIds(['env-a', 'env-b'], ['env-a'])).toEqual([
      'env-b'
    ])
    expect(getNewlyDisconnectedRuntimeEnvironmentIds(['env-a'], ['env-a', 'env-b'])).toEqual([])
  })
})

describe('getRuntimeProjectRefreshEnvironmentIds', () => {
  it('refreshes when an already-desired runtime becomes reachable', () => {
    expect(
      getRuntimeProjectRefreshEnvironmentIds({
        previousDesired: ['env-a'],
        nextDesired: ['env-a'],
        previousReachable: [],
        nextReachable: ['env-a']
      })
    ).toEqual(['env-a'])
  })

  it('deduplicates runtimes that are both newly desired and newly reachable', () => {
    expect(
      getRuntimeProjectRefreshEnvironmentIds({
        previousDesired: [],
        nextDesired: ['env-a'],
        previousReachable: [],
        nextReachable: ['env-a']
      })
    ).toEqual(['env-a'])
  })
})
