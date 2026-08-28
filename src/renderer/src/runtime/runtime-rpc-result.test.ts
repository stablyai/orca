import { describe, expect, it } from 'vitest'
import { hasRuntimeRpcErrorCode, RuntimeRpcCallError } from './runtime-rpc-result'

describe('hasRuntimeRpcErrorCode', () => {
  it('matches structured runtime failures through wrapped causes', () => {
    const failure = new RuntimeRpcCallError({
      id: 'rpc-1',
      ok: false,
      error: { code: 'selector_not_found', message: 'Selector not found' }
    })

    expect(
      hasRuntimeRpcErrorCode(new Error('remove failed', { cause: failure }), failure.code)
    ).toBe(true)
  })

  it('supports legacy response envelopes and exact plain errors', () => {
    expect(
      hasRuntimeRpcErrorCode(
        { response: { error: { message: 'repo_not_found' } } },
        'repo_not_found'
      )
    ).toBe(true)
    expect(hasRuntimeRpcErrorCode('repo_not_found', 'repo_not_found')).toBe(true)
  })

  // Why: Electron IPC and relay envelopes re-wrap the token into a longer message and drop the cause.
  it('matches codes re-wrapped into a transport message with no cause', () => {
    expect(
      hasRuntimeRpcErrorCode(
        new Error("Error invoking remote method 'worktrees:updateMeta': Error: selector_not_found"),
        'selector_not_found'
      )
    ).toBe(true)
    expect(hasRuntimeRpcErrorCode('Error: selector_not_found', 'selector_not_found')).toBe(true)
    expect(
      hasRuntimeRpcErrorCode(
        { message: 'relay call failed: selector_not_found\n' },
        'selector_not_found'
      )
    ).toBe(true)
    expect(
      hasRuntimeRpcErrorCode(
        new Error('worktree.set failed', {
          cause: new Error('Error invoking remote method: Error: selector_not_found')
        }),
        'selector_not_found'
      )
    ).toBe(true)
  })

  // Why: the destructive consumer forgets the workspace locally, so only a real message boundary may classify.
  it('rejects a trailing token that is not after a message boundary', () => {
    expect(
      hasRuntimeRpcErrorCode(new Error('failed to reach host for repo_not_found'), 'repo_not_found')
    ).toBe(false)
    expect(
      hasRuntimeRpcErrorCode(
        new Error('remote is unreachable, selector_not_found'),
        'selector_not_found'
      )
    ).toBe(false)
    expect(
      hasRuntimeRpcErrorCode({ message: 'timed out waiting for repo_not_found' }, 'repo_not_found')
    ).toBe(false)
    expect(
      hasRuntimeRpcErrorCode(new Error('host offline (selector_not_found'), 'selector_not_found')
    ).toBe(false)
  })

  it('rejects an unrelated failure re-wrapped around a token-shaped tail', () => {
    expect(
      hasRuntimeRpcErrorCode(
        new Error('worktree.rm failed while probing selector_not_found', {
          cause: new Error('connection reset by peer while resolving repo_not_found')
        }),
        'selector_not_found'
      )
    ).toBe(false)
    expect(
      hasRuntimeRpcErrorCode(
        {
          response: {
            error: { code: 'permission_denied', message: 'denied lookup of repo_not_found' }
          }
        },
        'repo_not_found'
      )
    ).toBe(false)
  })

  it('matches a token placed on its own line by a multi-line transport message', () => {
    expect(
      hasRuntimeRpcErrorCode(
        new Error('relay envelope rejected the call\nselector_not_found'),
        'selector_not_found'
      )
    ).toBe(true)
  })

  it('rejects diagnostic mentions and cyclic causes', () => {
    const cycle: { cause?: unknown; message: string } = { message: 'permission_denied' }
    cycle.cause = cycle

    expect(
      hasRuntimeRpcErrorCode(
        new Error('Access denied after a prior selector_not_found diagnostic'),
        'selector_not_found'
      )
    ).toBe(false)
    expect(hasRuntimeRpcErrorCode(cycle, 'selector_not_found')).toBe(false)
    // A longer identifier that merely ends in the token is a different code.
    expect(
      hasRuntimeRpcErrorCode(new Error('stale_selector_not_found'), 'selector_not_found')
    ).toBe(false)
  })
})
