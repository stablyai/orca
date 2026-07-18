import { describe, expect, it } from 'vitest'
import type { WebAiAccount } from '../../../shared/types'
import { getWebAiBrowserProfileOperationOwner } from './browser-profile-operation-owner'

const account: WebAiAccount = {
  id: 'account-1',
  provider: 'chatgpt',
  label: 'Personal ChatGPT',
  executionHostId: 'local',
  profileId: 'profile-1',
  sessionPartition: 'persist:profile-1',
  createdAt: 1
}

describe('getWebAiBrowserProfileOperationOwner', () => {
  it('pins tagged Web AI accounts to the local Electron owner', () => {
    expect(getWebAiBrowserProfileOperationOwner(account)).toEqual({ runtimeEnvironmentId: null })
  })

  it('leaves ordinary browser pages on their existing owner resolution path', () => {
    expect(getWebAiBrowserProfileOperationOwner(null)).toBeUndefined()
  })
})
