import { describe, expect, it } from 'vitest'
import { hostScopeCensusIsComplete } from './runtime-listing-host-scope'

/** Disclosure and owed coverage differ; pin the disagreements behind #18595. */
describe('hostScopeCensusIsComplete', () => {
  it('reads a peer runtime as disclosure, not as coverage this host owed', () => {
    expect(
      hostScopeCensusIsComplete({ hostIds: ['local'], omittedHostIds: ['runtime:env-7'] })
    ).toBe(true)
  })

  it('still reads an SSH host as a gap, because this runtime does query those', () => {
    expect(hostScopeCensusIsComplete({ hostIds: ['local'], omittedHostIds: ['ssh:box-1'] })).toBe(
      false
    )
  })

  it('reads a mixed omission as incomplete on the strength of the SSH host alone', () => {
    expect(
      hostScopeCensusIsComplete({
        hostIds: ['local'],
        omittedHostIds: ['runtime:env-7', 'ssh:box-1']
      })
    ).toBe(false)
  })

  it('calls a clean census complete', () => {
    expect(hostScopeCensusIsComplete({ hostIds: ['local', 'ssh:box-1'], omittedHostIds: [] })).toBe(
      true
    )
  })

  // Even if local stops being seeded, a listing covering no host must never read complete.
  it('refuses a listing that covered no host at all', () => {
    expect(hostScopeCensusIsComplete({ hostIds: [], omittedHostIds: ['runtime:env-7'] })).toBe(
      false
    )
    expect(hostScopeCensusIsComplete({ hostIds: [], omittedHostIds: [] })).toBe(false)
  })

  // Missing scope on pre-v1.4.187 hosts is never a completeness claim.
  it('refuses a host too old to publish a scope', () => {
    expect(hostScopeCensusIsComplete(undefined)).toBe(false)
  })

  // An unreadable covered-host ID cannot establish completeness.
  it('refuses a coverage claim with no legible host in it', () => {
    expect(
      hostScopeCensusIsComplete({
        hostIds: ['runtime:' as never],
        omittedHostIds: ['runtime:env-7']
      })
    ).toBe(false)
  })

  // One legible host suffices so future host kinds do not make census completeness permanently fail.
  it('accepts a coverage claim carrying one legible host beside an unreadable one', () => {
    expect(
      hostScopeCensusIsComplete({ hostIds: ['local', 'newkind:x' as never], omittedHostIds: [] })
    ).toBe(true)
  })

  it('refuses an unparseable host id rather than discounting it', () => {
    expect(
      hostScopeCensusIsComplete({
        hostIds: ['local'],
        omittedHostIds: ['runtime:' as never]
      })
    ).toBe(false)
  })
})
