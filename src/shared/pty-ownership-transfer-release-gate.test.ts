import { describe, expect, it } from 'vitest'
import {
  isPtyOwnershipTransferMutationEnabled,
  PTY_OWNERSHIP_TRANSFER_CANARY_ENV
} from './pty-ownership-transfer-release-gate'

describe('PTY ownership-transfer release gate', () => {
  it('is closed unless the exact canary value is present', () => {
    expect(isPtyOwnershipTransferMutationEnabled({})).toBe(false)
    expect(
      isPtyOwnershipTransferMutationEnabled({
        [PTY_OWNERSHIP_TRANSFER_CANARY_ENV]: 'true'
      })
    ).toBe(false)
    expect(
      isPtyOwnershipTransferMutationEnabled({
        [PTY_OWNERSHIP_TRANSFER_CANARY_ENV]: '1 '
      })
    ).toBe(false)
  })

  it('opens only for an explicit canary opt-in', () => {
    expect(
      isPtyOwnershipTransferMutationEnabled({
        [PTY_OWNERSHIP_TRANSFER_CANARY_ENV]: '1'
      })
    ).toBe(true)
  })
})
