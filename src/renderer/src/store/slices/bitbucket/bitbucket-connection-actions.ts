import {
  bitbucketConnectionStatus,
  connectBitbucketCredentials,
  disconnectBitbucketCredentials
} from '@/runtime/bitbucket/runtime-bitbucket-client'
import { defaultScopeSource } from '@/runtime/hosts/selection/default-creation-host'
import type { AppState } from '../../types'
import type { BitbucketSlice } from './bitbucket-slice-contract'

export function createBitbucketConnectionActions(
  get: () => AppState
): Pick<
  BitbucketSlice,
  'readBitbucketConnectionStatus' | 'connectBitbucket' | 'disconnectBitbucket'
> {
  return {
    readBitbucketConnectionStatus: () =>
      bitbucketConnectionStatus(defaultScopeSource(get().settings)),
    connectBitbucket: (args) =>
      connectBitbucketCredentials(defaultScopeSource(get().settings), args),
    disconnectBitbucket: () => disconnectBitbucketCredentials(defaultScopeSource(get().settings))
  }
}
