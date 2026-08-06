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

  // Why: reconnect/restore callers may pass the execution-host id form
  // ("ssh:<targetId>") from a workspace `hostId`; it names the same connection
  // as the bare id embedded in the app pty id and must not throw or misencode.
  it('accepts the execution-host id form as the same connection', () => {
    expect(toRelaySshPtyId(HOST_ID, APP_ID)).toBe('pty-3')
    expect(toAppSshPtyId(HOST_ID, APP_ID)).toBe(APP_ID)
    // A fresh app id built from the host-id form still stores the bare id.
    expect(toAppSshPtyId(HOST_ID, 'pty-7')).toBe('ssh:ssh-1779863656395-57g1q1@@pty-7')
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
