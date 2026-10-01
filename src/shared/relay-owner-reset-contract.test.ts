import { describe, expect, it } from 'vitest'
import {
  RELAY_DURABLE_RESET_PREPARATION_CAPABILITY,
  RELAY_OWNER_RESET_CAPABILITY,
  RELAY_OWNER_RESET_METHOD,
  RELAY_PREPARED_RESET_RECOVERY_METHOD
} from './relay-owner-reset-contract'
import { RELAY_RESET_PREPARATION_READ_FLAG } from './relay-reset-preparation-contract'
import { allowsRelayWorkDuringDrain } from './relay-work-drain-contract'

// Relays and clients update independently, so these names are permanent once released.
describe('relay owner-reset wire contract', () => {
  it('pins the advertised capabilities, methods and reader flag', () => {
    expect(RELAY_OWNER_RESET_CAPABILITY).toBe('relay.ownerReset.v1')
    expect(RELAY_DURABLE_RESET_PREPARATION_CAPABILITY).toBe('relay.durableResetPreparation.v1')
    expect(RELAY_OWNER_RESET_METHOD).toBe('relay.reset')
    expect(RELAY_PREPARED_RESET_RECOVERY_METHOD).toBe('relay.recoverPreparedReset')
    expect(RELAY_RESET_PREPARATION_READ_FLAG).toBe('--read-reset-preparation')
  })

  it('admits both reset requests during a work drain, so a prepared reset can settle', () => {
    expect(allowsRelayWorkDuringDrain(RELAY_OWNER_RESET_METHOD)).toBe(true)
    expect(allowsRelayWorkDuringDrain(RELAY_PREPARED_RESET_RECOVERY_METHOD)).toBe(true)
  })
})
