/**
 * `isOwnerContactFailure` decides whether a failed `repo.rm` is a refusal the owning host made
 * (a failure) or silence (`owner-unverifiable`). Under docs/reference/ssh-execution-boundary.md
 * only an answer is evidence, so a request that never left this machine must classify as silence.
 */
import { describe, expect, it } from 'vitest'
import { isOwnerContactFailure } from './project-removal-outcome'

describe('isOwnerContactFailure', () => {
  it.each([
    'remote_runtime_unavailable',
    'runtime_rpc_queue_overloaded',
    'runtime_timeout',
    'runtime_unavailable',
    'timeout'
  ])('treats the transport code %s as no answer', (code) => {
    expect(isOwnerContactFailure({ code, message: 'transport failed' })).toBe(true)
  })

  // The client short-circuits before dispatching, so the host never saw the request. Classifying
  // it as a refusal reported `failed` and hid the client-only forget this outcome exists for.
  it('treats a manually disconnected environment as no answer', () => {
    expect(
      isOwnerContactFailure({
        code: 'runtime_manually_disconnected',
        message: 'Runtime environment is manually disconnected.'
      })
    ).toBe(true)
  })

  it.each([
    new Error('runtime_manually_disconnected'),
    new Error('Runtime environment is manually disconnected.')
  ])('treats an untyped manual disconnect as no answer: %s', (error) => {
    expect(isOwnerContactFailure(error)).toBe(true)
  })

  it('keeps a host that answered and refused a failure', () => {
    expect(isOwnerContactFailure({ code: 'unauthorized', message: 'bad token' })).toBe(false)
    expect(isOwnerContactFailure({ code: 'repo_in_use', message: 'project is busy' })).toBe(false)
  })

  // A code is authoritative here exactly as it is in the shared classifier: a host that refused
  // must not be re-read as silence because its prose mentions a disconnect.
  it('trusts a refusal code over disconnect-sounding prose', () => {
    expect(
      isOwnerContactFailure({
        code: 'unauthorized',
        message: 'Runtime environment is manually disconnected.'
      })
    ).toBe(false)
  })
})
