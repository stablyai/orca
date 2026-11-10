import { afterEach, describe, expect, it } from 'vitest'
import {
  cancelOrcaCloudSelectionAfterSignIn,
  requestOrcaCloudSelectionAfterSignIn,
  takeOrcaCloudSelectionAfterSignIn
} from './orca-cloud-select-after-sign-in'

const local = { id: 'plugin:vm', provider: 'plugin' }
const cloud = { id: 'cloud', provider: 'orca-cloud' }

describe('Orca Cloud selection after signing in from the picker', () => {
  afterEach(() => cancelOrcaCloudSelectionAfterSignIn())

  it('selects Orca Cloud once the reloaded recipe list offers it, then only once', () => {
    requestOrcaCloudSelectionAfterSignIn(1_000)
    // Before main sees the sign-in the list has no Orca Cloud recipe: keep waiting.
    expect(takeOrcaCloudSelectionAfterSignIn([local], 2_000)).toBeNull()
    expect(takeOrcaCloudSelectionAfterSignIn([local, cloud], 3_000)).toBe('cloud')
    expect(takeOrcaCloudSelectionAfterSignIn([local, cloud], 4_000)).toBeNull()
  })

  it('does nothing without a sign-in from the row, after a cancel, or once the intent is stale', () => {
    expect(takeOrcaCloudSelectionAfterSignIn([cloud], 1_000)).toBeNull()
    requestOrcaCloudSelectionAfterSignIn(1_000)
    cancelOrcaCloudSelectionAfterSignIn()
    expect(takeOrcaCloudSelectionAfterSignIn([cloud], 2_000)).toBeNull()
    requestOrcaCloudSelectionAfterSignIn(1_000)
    expect(takeOrcaCloudSelectionAfterSignIn([cloud], 1_000 + 11 * 60_000)).toBeNull()
  })
})
