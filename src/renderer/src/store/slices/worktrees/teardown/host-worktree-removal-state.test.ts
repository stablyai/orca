import { describe, expect, it } from 'vitest'
import { RemoteRuntimeClientError } from '../../../../../../shared/remote-runtime-client-error'
import { RuntimeRpcCallQueueOverloadError } from '../../../../../../shared/runtime-rpc-call-queue'
import { isWorktreeRemovalReplyLost } from './host-worktree-removal-state'

// Pins which delete failures wait on the host's listing (round-2 S5), so a dropped code is deliberate.
describe('isWorktreeRemovalReplyLost', () => {
  it.each([
    'remote_runtime_unavailable',
    'remote_runtime_busy',
    'runtime_timeout',
    'runtime_unavailable',
    'reconnecting',
    'timeout'
  ])('treats %s as a lost reply', (code) => {
    expect(isWorktreeRemovalReplyLost(new RemoteRuntimeClientError(code, 'transport failed'))).toBe(
      true
    )
  })

  it('treats a queue overload as never sent', () => {
    expect(isWorktreeRemovalReplyLost(new RuntimeRpcCallQueueOverloadError('global'))).toBe(false)
    expect(
      isWorktreeRemovalReplyLost(
        new Error(
          "Error invoking remote method 'x': Error: Remote runtime call queue is full; retry after current calls finish."
        )
      )
    ).toBe(false)
  })

  it.each([
    'runtime_manually_disconnected',
    'invalid_runtime_response',
    'unauthorized',
    'worktree_not_found'
  ])('does not treat %s as a lost reply', (code) => {
    expect(isWorktreeRemovalReplyLost(new RemoteRuntimeClientError(code, 'refused'))).toBe(false)
  })

  it.each([
    "Error invoking remote method 'x': Error: Request timed out.",
    "Error invoking remote method 'x': Error: Remote Orca runtime connection interrupted.",
    "Error invoking remote method 'x': Error: Could not connect to the remote Orca runtime."
  ])('treats the code-stripped message "%s" as a lost reply', (message) => {
    expect(isWorktreeRemovalReplyLost(new Error(message))).toBe(true)
  })
})
