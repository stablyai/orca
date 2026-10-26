import { describe, expect, it } from 'vitest'
import { toSshExecutionHostId } from './execution-host'
import { parseAppSshPtyId, toAppSshPtyId, toRelaySshPtyId } from './ssh-pty-id'

describe('ssh pty id routing', () => {
  const CONNECTION = 'ssh-1779863656395-57g1q1'
  const HOST_ID = toSshExecutionHostId(CONNECTION) // "ssh:ssh-1779863656395-57g1q1"
  const APP_ID = toAppSshPtyId(CONNECTION, 'pty-3') // "ssh:ssh-1779863656395-57g1q1@@pty-3"

  it('encodes the bare target id into the app pty id', () => {
    expect(APP_ID).toBe('ssh:ssh-1779863656395-57g1q1@@pty-3')
    expect(parseAppSshPtyId(APP_ID)).toEqual({ connectionId: CONNECTION, relayPtyId: 'pty-3' })
  })

  it('round-trips app <-> relay ids for the matching bare connection', () => {
    expect(toRelaySshPtyId(CONNECTION, APP_ID)).toBe('pty-3')
    expect(toAppSshPtyId(CONNECTION, APP_ID)).toBe(APP_ID)
  })

  // Reconnect callers may supply workspace hostId (ssh:<targetId>); it must route identically to the bare target ID.
  it('accepts the execution-host id form as the same connection', () => {
    expect(toRelaySshPtyId(HOST_ID, APP_ID)).toBe('pty-3')
    expect(toAppSshPtyId(HOST_ID, APP_ID)).toBe(APP_ID)
    expect(toAppSshPtyId(HOST_ID, 'pty-7')).toBe('ssh:ssh-1779863656395-57g1q1@@pty-7')
  })

  // Older wrappers split on the first @@; colons inside epoch-scoped IDs must survive round trips.
  it('round-trips a mint-epoch relay pty id', () => {
    const relayPtyId = 'pty2:0f8fad5b-d9cb-469f-a165-70867728950e:12'
    const appId = toAppSshPtyId(CONNECTION, relayPtyId)

    expect(appId).toBe(`ssh:${CONNECTION}@@${relayPtyId}`)
    expect(parseAppSshPtyId(appId)).toEqual({ connectionId: CONNECTION, relayPtyId })
    expect(toRelaySshPtyId(CONNECTION, appId)).toBe(relayPtyId)
    expect(toRelaySshPtyId(HOST_ID, appId)).toBe(relayPtyId)
    expect(toAppSshPtyId(CONNECTION, appId)).toBe(appId)
    expect(() => toRelaySshPtyId('ssh-other', appId)).toThrow(
      `belongs to SSH connection "${CONNECTION}"`
    )
  })

  it('still rejects a pty id owned by a genuinely different connection', () => {
    expect(() => toRelaySshPtyId('ssh-other', APP_ID)).toThrow(
      `belongs to SSH connection "${CONNECTION}"`
    )
    expect(() => toAppSshPtyId(toSshExecutionHostId('ssh-other'), APP_ID)).toThrow(
      `belongs to SSH connection "${CONNECTION}"`
    )
  })
})
