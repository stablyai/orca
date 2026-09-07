import { describe, expect, it } from 'vitest'
import { hostScopeCensusIsComplete } from './runtime-listing-host-scope'

/**
 * The gate and the disclosure list answer different questions off the same field. These pin the
 * cases where they disagree — which is every case that mattered in #18595.
 */
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

  // Defence in depth: `listKnownExecutionHostIds` always seeds `local`, so a real scope that
  // covered nothing also omits `local` and is refused by the runtime-only rule anyway. This
  // branch is what stops a scope that answered for no host from ever reading complete if that
  // ever stops holding.
  it('refuses a listing that covered no host at all', () => {
    expect(hostScopeCensusIsComplete({ hostIds: [], omittedHostIds: ['runtime:env-7'] })).toBe(
      false
    )
    expect(hostScopeCensusIsComplete({ hostIds: [], omittedHostIds: [] })).toBe(false)
  })

  // Why: `hostScope` shipped in v1.4.187. An older host cannot say what it covered, and absence
  // of the claim is never the claim — this must stay the first branch.
  it('refuses a host too old to publish a scope', () => {
    expect(hostScopeCensusIsComplete(undefined)).toBe(false)
  })

  // Why: without this the runtime-only rule trusts a coverage claim it cannot read — the shape
  // `{hostIds: ['runtime:'], omittedHostIds: ['runtime:env-7']}` was `unverifiable` before the
  // gate changed and must not become `complete` on the strength of an unparseable id.
  it('refuses a coverage claim with no legible host in it', () => {
    expect(
      hostScopeCensusIsComplete({
        hostIds: ['runtime:' as never],
        omittedHostIds: ['runtime:env-7']
      })
    ).toBe(false)
  })

  // Why "at least one legible" and not "all legible": a host that later gains a kind this client
  // cannot parse must not report an incomplete census forever — that is this bug in a new coat.
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
