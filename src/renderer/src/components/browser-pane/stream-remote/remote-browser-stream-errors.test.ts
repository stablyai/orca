import { describe, expect, it } from 'vitest'
import {
  isPermanentRemoteBrowserStreamFailure,
  remoteBrowserStreamUnsupportedError,
  resolveRemoteBrowserStreamRestartFailure
} from './remote-browser-stream-errors'

function rpcError(code: string, message = 'boom'): Error {
  return Object.assign(new Error(message), { code })
}

// Why this file exists: the permanent set decides whether the pane ever retries on its own, and it
// was enforced by nothing — re-adding `selector_not_found` (the exact code 08260a54bf had to walk
// back out) left the whole suite green, as did deleting two of the three members.
describe('remote browser stream failure classification', () => {
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

  // The regression guard. `selector_not_found` means "I could not resolve this right now" — its
  // producer is a live worktree scan behind a 1s TTL cache, and the connectionId-gated fallback that
  // shields SSH repos from scan lag does not cover purely local ones. Treating it as permanent
  // stopped retries on a blip and stranded the pane, which is the bug this area exists to prevent.
  it('does not treat an unresolved selector as proof the target is gone', () => {
    expect(isPermanentRemoteBrowserStreamFailure(rpcError('selector_not_found'))).toBe(false)
    expect(
      resolveRemoteBrowserStreamRestartFailure(rpcError('selector_not_found')).shouldRetry
    ).toBe(true)
  })

  it('keeps unknown and transport failures retryable', () => {
    for (const code of ['runtime_unavailable', 'runtime_timeout', 'socket_closed']) {
      expect(isPermanentRemoteBrowserStreamFailure(rpcError(code))).toBe(false)
    }
    expect(isPermanentRemoteBrowserStreamFailure(new Error('no code at all'))).toBe(false)
    expect(isPermanentRemoteBrowserStreamFailure(null)).toBe(false)
  })

  it('keeps a permanent failure specific and replaces only raw transient text', () => {
    const permanent = resolveRemoteBrowserStreamRestartFailure(
      rpcError('worktree_not_found_on_server', 'worktree is gone')
    )
    // Its own message says something true that a generic "lost connection" would not.
    expect(permanent.message).toBe('worktree is gone')
    expect(permanent.shouldRetry).toBe(false)
    expect(permanent.logRawError).toBe(false)

    const transient = resolveRemoteBrowserStreamRestartFailure(
      rpcError('runtime_unavailable', 'Runtime environment is manually disconnected.')
    )
    expect(transient.message).toBe('Lost connection to the remote server.')
    expect(transient.shouldRetry).toBe(true)
    // Dropped from the UI but not lost: nothing else records it.
    expect(transient.logRawError).toBe(true)
  })

  it('uses localized copy for permanent failures without an Error message', () => {
    const failure = resolveRemoteBrowserStreamRestartFailure({
      code: 'worktree_not_found_on_server'
    })

    expect(failure.message).toBe('Failed to restart remote browser stream.')
    expect(failure.shouldRetry).toBe(false)
  })
})
