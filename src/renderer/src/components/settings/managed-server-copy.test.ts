import { describe, expect, it } from 'vitest'
import { ORCAD_UPDATE_WSL_MOVE_RUNNING_CODE } from '../../../../shared/wsl-host-types'
import { managedServerOutcomeLabel } from './managed-server-copy'

describe('managedServerOutcomeLabel', () => {
  it('says a WSL server update waits for the project moving onto it', () => {
    expect(
      managedServerOutcomeLabel({ outcome: 'deferred', code: ORCAD_UPDATE_WSL_MOVE_RUNNING_CODE })
    ).toBe(
      'Not done: a project is moving onto this server. Orca updates it once the move finishes.'
    )
  })
})
