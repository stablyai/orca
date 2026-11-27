import type {
  BitbucketConnectArgs,
  BitbucketConnectResult,
  BitbucketConnectionStatus
} from '../../../../../shared/bitbucket/bitbucket-credentials'

export type BitbucketSlice = {
  /** Metadata-only credential read for the settings scope; never decrypts secrets. */
  readBitbucketConnectionStatus: () => Promise<BitbucketConnectionStatus>
  connectBitbucket: (args: BitbucketConnectArgs) => Promise<BitbucketConnectResult>
  disconnectBitbucket: () => Promise<void>
}
