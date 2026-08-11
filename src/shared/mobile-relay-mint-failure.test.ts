import { describe, expect, it } from 'vitest'
import { mobileRelayMintFailureFromUnknown } from './mobile-relay-mint-failure'

describe('mobileRelayMintFailureFromUnknown', () => {
  it('keeps known machine-readable Relay codes for diagnostics', () => {
    expect(
      mobileRelayMintFailureFromUnknown({
        stage: 'create_pairing_relay',
        error: new Error('relay_control_not_active'),
        fallbackCode: 'relay_mint_failed',
        fallbackMessage: 'Relay pairing invite request failed'
      })
    ).toEqual({
      code: 'relay_control_not_active',
      stage: 'create_pairing_relay',
      message: 'Relay pairing invite request failed'
    })
  })

  it('keeps known codes carried on structured error objects', () => {
    expect(
      mobileRelayMintFailureFromUnknown({
        stage: 'create_pairing_relay',
        error: { code: 'relay_control_not_active' },
        fallbackCode: 'relay_mint_failed',
        fallbackMessage: 'Relay pairing invite request failed'
      })
    ).toEqual({
      code: 'relay_control_not_active',
      stage: 'create_pairing_relay',
      message: 'Relay pairing invite request failed'
    })
  })

  it('reads a Relay code off a message that is not carried by an Error', () => {
    expect(
      mobileRelayMintFailureFromUnknown({
        stage: 'create_pairing_relay',
        error: { message: 'relay_control_not_active' },
        fallbackCode: 'relay_mint_failed',
        fallbackMessage: 'Relay pairing invite request failed'
      })
    ).toEqual({
      code: 'relay_control_not_active',
      stage: 'create_pairing_relay',
      message: 'Relay pairing invite request failed'
    })
  })

  it('falls back for error values that are neither objects nor Errors', () => {
    expect(
      mobileRelayMintFailureFromUnknown({
        stage: 'create_pairing_relay',
        error: 'relay_control_not_active',
        fallbackCode: 'relay_mint_failed',
        fallbackMessage: 'Relay pairing invite request failed'
      })
    ).toEqual({
      code: 'relay_mint_failed',
      stage: 'create_pairing_relay',
      message: 'Relay pairing invite request failed'
    })
  })

  it('carries the transport reason a relay_* code cannot express', () => {
    expect(
      mobileRelayMintFailureFromUnknown({
        stage: 'create_pairing_relay',
        error: new TypeError('fetch failed', {
          cause: Object.assign(new Error('...'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })
        }),
        fallbackCode: 'relay_mint_failed',
        fallbackMessage: 'Relay pairing invite request failed'
      })
    ).toEqual({
      code: 'relay_mint_failed',
      stage: 'create_pairing_relay',
      message: 'Relay pairing invite request failed',
      networkCode: 'SELF_SIGNED_CERT_IN_CHAIN'
    })
  })

  it('redacts free-form error messages', () => {
    expect(
      mobileRelayMintFailureFromUnknown({
        stage: 'create_pairing_relay',
        error: new Error('request failed for https://relay.example/token/secret'),
        fallbackCode: 'relay_mint_failed',
        fallbackMessage: 'Relay pairing invite request failed'
      })
    ).toEqual({
      code: 'relay_mint_failed',
      stage: 'create_pairing_relay',
      message: 'Relay pairing invite request failed'
    })
  })

  it('still returns a structured failure when the error resists inspection', () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('boom')
        },
        get: () => {
          throw new Error('boom')
        },
        has: () => {
          throw new Error('boom')
        }
      }
    )
    expect(
      mobileRelayMintFailureFromUnknown({
        stage: 'create_pairing_relay',
        error: hostile,
        fallbackCode: 'relay_mint_failed',
        fallbackMessage: 'Relay pairing invite request failed'
      })
    ).toEqual({
      code: 'relay_mint_failed',
      stage: 'create_pairing_relay',
      message: 'Relay pairing invite request failed'
    })
  })

  it('does not admit a request URL through the transport code', () => {
    expect(
      mobileRelayMintFailureFromUnknown({
        stage: 'create_pairing_relay',
        error: new TypeError('fetch failed', {
          cause: { code: 'https://relay.example/v1/assign?token=secret' }
        }),
        fallbackCode: 'relay_mint_failed',
        fallbackMessage: 'Relay pairing invite request failed'
      })
    ).toEqual({
      code: 'relay_mint_failed',
      stage: 'create_pairing_relay',
      message: 'Relay pairing invite request failed'
    })
  })
})
