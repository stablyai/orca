import { describe, expect, it } from 'vitest'
import inputEventsFixture from '../../native/codex-micro/fixtures/input-events.json'
import radarEventsFixture from '../../native/codex-micro/fixtures/radar-events.json'
import { parseCodexMicroConnectionState, parseCodexMicroInputEvent } from './codex-micro-types'

describe('parseCodexMicroInputEvent', () => {
  it('parses every proven control press/release/step event from the capture fixture', () => {
    for (const event of inputEventsFixture.events) {
      expect(parseCodexMicroInputEvent(event)).toEqual(event)
    }
  })

  it('parses every radar event from the capture fixture', () => {
    for (const event of radarEventsFixture.events) {
      expect(parseCodexMicroInputEvent(event)).toEqual(event)
    }
  })

  it('rejects an unknown control id', () => {
    expect(parseCodexMicroInputEvent({ kind: 'control', control: 'BOGUS', action: 1 })).toBeNull()
  })

  it('rejects a press/release action on an encoder rotation control', () => {
    expect(parseCodexMicroInputEvent({ kind: 'control', control: 'ENC_CC', action: 1 })).toBeNull()
  })

  it('rejects a step action on a non-encoder control', () => {
    expect(parseCodexMicroInputEvent({ kind: 'control', control: 'AG00', action: 2 })).toBeNull()
  })

  it('rejects an out-of-range action', () => {
    expect(parseCodexMicroInputEvent({ kind: 'control', control: 'AG00', action: 3 })).toBeNull()
  })

  it('rejects non-finite radar angle or distance', () => {
    expect(
      parseCodexMicroInputEvent({ kind: 'radar', angle: Number.NaN, distance: 0.5 })
    ).toBeNull()
    expect(
      parseCodexMicroInputEvent({ kind: 'radar', angle: 0.5, distance: Number.POSITIVE_INFINITY })
    ).toBeNull()
  })

  it('rejects an unrecognized event shape', () => {
    expect(parseCodexMicroInputEvent({ kind: 'bogus' })).toBeNull()
    expect(parseCodexMicroInputEvent(null)).toBeNull()
  })
})

describe('parseCodexMicroConnectionState', () => {
  it('parses simple lifecycle states', () => {
    expect(parseCodexMicroConnectionState({ kind: 'disabled' })).toEqual({ kind: 'disabled' })
    expect(parseCodexMicroConnectionState({ kind: 'connecting' })).toEqual({ kind: 'connecting' })
  })

  it('parses a connected state with known firmware', () => {
    expect(
      parseCodexMicroConnectionState({
        kind: 'connected',
        firmware: 'v0.4.1',
        battery: 81,
        charging: true
      })
    ).toEqual({ kind: 'connected', firmware: 'v0.4.1', battery: 81, charging: true })
  })

  it('rejects a connected state claiming unproven firmware', () => {
    expect(parseCodexMicroConnectionState({ kind: 'connected', firmware: 'v0.9.9' })).toBeNull()
  })

  it('rejects invalid connected battery values', () => {
    expect(
      parseCodexMicroConnectionState({ kind: 'connected', firmware: 'v0.4.1', battery: -1 })
    ).toBeNull()
    expect(
      parseCodexMicroConnectionState({ kind: 'connected', firmware: 'v0.4.1', battery: 101 })
    ).toBeNull()
    expect(
      parseCodexMicroConnectionState({ kind: 'connected', firmware: 'v0.4.1', battery: 1.5 })
    ).toBeNull()
  })

  it('parses a redacted error state with only code and message', () => {
    expect(
      parseCodexMicroConnectionState({ kind: 'error', code: 'sidecar-crash', message: 'restarted' })
    ).toEqual({ kind: 'error', code: 'sidecar-crash', message: 'restarted' })
  })

  it('rejects an error state carrying an unredacted payload key', () => {
    expect(
      parseCodexMicroConnectionState({
        kind: 'error',
        code: 'sidecar-crash',
        message: 'restarted',
        serialNumber: 'DEVICE-SERIAL'
      })
    ).toBeNull()
    expect(
      parseCodexMicroConnectionState({
        kind: 'permission-error',
        code: 'hidraw-denied',
        message: 'denied',
        rawReport: [6, 2, 1]
      })
    ).toBeNull()
    expect(
      parseCodexMicroConnectionState({
        kind: 'conflict',
        code: 'device-claimed',
        message: 'owned elsewhere',
        path: '/dev/hidraw0'
      })
    ).toBeNull()
  })
})
