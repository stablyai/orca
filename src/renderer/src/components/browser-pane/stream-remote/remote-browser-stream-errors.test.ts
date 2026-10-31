import { describe, expect, it } from 'vitest'
import {
  isPermanentRemoteBrowserStreamFailure,
  remoteBrowserStreamUnsupportedError,
  resolveRemoteBrowserStreamFailure
} from './remote-browser-stream-errors'

function rpcError(code: string, message = 'boom'): Error {
  return Object.assign(new Error(message), { code })
}

describe('remote browser stream failure classification', () => {
  it.each(['opening', 'restart'] as const)(
    'distinguishes browser setup from transport during %s',
    (phase) => {
      const failure = resolveRemoteBrowserStreamFailure(
        rpcError('browser_unavailable', 'unconfigured backend'),
        phase
      )
      expect(failure.message).toBe(
        'The remote browser is unavailable. Check its setup on the server.'
      )
      expect(failure.shouldRetry).toBe(true)
      expect(failure.logRawError).toBe(true)
      expect(isPermanentRemoteBrowserStreamFailure(rpcError('browser_unavailable'))).toBe(false)
    }
  )

  it('keeps the initial transport failure distinct from a lost stream', () => {
    expect(resolveRemoteBrowserStreamFailure(rpcError('runtime_timeout'), 'opening').message).toBe(
      'Cannot reach the remote server.'
    )
  })

  it('treats only codes that prove the target is gone as permanent', () => {
    for (const code of [
      'worktree_not_found_on_server',
      'repo_not_found',
      'capability_unsupported'
    ]) {
      expect(isPermanentRemoteBrowserStreamFailure(rpcError(code))).toBe(true)
    }
    expect(isPermanentRemoteBrowserStreamFailure(remoteBrowserStreamUnsupportedError())).toBe(true)
  })

  // selector_not_found can reflect scan-cache lag, including local worktrees; it cannot prove permanent loss.
  it('does not treat an unresolved selector as proof the target is gone', () => {
    expect(isPermanentRemoteBrowserStreamFailure(rpcError('selector_not_found'))).toBe(false)
    expect(resolveRemoteBrowserStreamFailure(rpcError('selector_not_found')).shouldRetry).toBe(true)
  })

  it('keeps unknown and transport failures retryable', () => {
    for (const code of ['runtime_unavailable', 'runtime_timeout', 'socket_closed']) {
      expect(isPermanentRemoteBrowserStreamFailure(rpcError(code))).toBe(false)
    }
    expect(isPermanentRemoteBrowserStreamFailure(new Error('no code at all'))).toBe(false)
    expect(isPermanentRemoteBrowserStreamFailure(null)).toBe(false)
  })

  it('keeps a permanent failure specific and replaces only raw transient text', () => {
    const permanent = resolveRemoteBrowserStreamFailure(
      rpcError('worktree_not_found_on_server', 'worktree is gone')
    )
    // Its own message says something true that a generic "lost connection" would not.
    expect(permanent.message).toBe('worktree is gone')
    expect(permanent.shouldRetry).toBe(false)
    expect(permanent.logRawError).toBe(false)

    const transient = resolveRemoteBrowserStreamFailure(
      rpcError('runtime_unavailable', 'Runtime environment is manually disconnected.')
    )
    expect(transient.message).toBe('Lost connection to the remote server.')
    expect(transient.shouldRetry).toBe(true)
    // Dropped from the UI but not lost: nothing else records it.
    expect(transient.logRawError).toBe(true)
  })

  it('uses localized copy for permanent failures without an Error message', () => {
    const failure = resolveRemoteBrowserStreamFailure({
      code: 'worktree_not_found_on_server'
    })

    expect(failure.message).toBe('Failed to restart remote browser stream.')
    expect(failure.shouldRetry).toBe(false)
  })
})
