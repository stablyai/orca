import { describe, expect, it } from 'vitest'
import { classifyWorkingTreeCarryRejection } from './runtime-git-working-tree-carry-rejection'
import { RuntimeRpcCallError } from './runtime-rpc-result'

function rpcError(code: string, message: string): RuntimeRpcCallError {
  return new RuntimeRpcCallError({
    id: 'git.carryWorkingTreeChanges',
    ok: false,
    error: { code, message }
  })
}

describe('classifyWorkingTreeCarryRejection', () => {
  it.each([
    ['runtime_rpc_queue_overloaded', 'Remote runtime call queue is full.'],
    ['method_not_found', 'Unknown method: git.carryWorkingTreeChanges'],
    ['method_not_supported', 'git.carryWorkingTreeChanges is not supported'],
    ['invalid_argument', 'Missing targetWorktree'],
    ['invalid_params', 'Invalid params'],
    ['capability_unsupported', 'Not supported by this host'],
    ['selector_not_found', 'No worktree matches id:wt-2'],
    ['selector_ambiguous', 'More than one worktree matches'],
    ['unauthorized', 'Pair this client again.']
  ])(
    'reports nothing written when the host rejected the call before running it (%s)',
    (code, message) => {
      expect(classifyWorkingTreeCarryRejection(rpcError(code, message))).toBe('apply_failed')
    }
  )

  it('reports nothing written when the socket released the request before sending it', () => {
    expect(
      classifyWorkingTreeCarryRejection(
        rpcError(
          'remote_runtime_unavailable',
          'Remote Orca runtime request was released before it could be sent.'
        )
      )
    ).toBe('apply_failed')
  })

  it('reports nothing written for a token-only rejection rewrapped by Electron IPC', () => {
    expect(
      classifyWorkingTreeCarryRejection(
        new Error("Error invoking remote method 'x': Error: runtime_rpc_queue_overloaded")
      )
    ).toBe('apply_failed')
  })

  it('reports nothing written when an older SSH relay has no carry handler', () => {
    expect(
      classifyWorkingTreeCarryRejection(
        new Error(
          "Error invoking remote method 'git:carryWorkingTreeChanges': Error: Method not found: git.carryWorkingTreeChanges"
        )
      )
    ).toBe('apply_failed')
  })

  it.each([
    ['runtime_timeout', 'Timed out waiting for the remote Orca runtime to respond.'],
    ['timeout', 'Timed out waiting for the remote Orca runtime.'],
    ['reconnecting', 'Remote Orca runtime is reconnecting.'],
    ['remote_runtime_unavailable', 'Remote Orca runtime closed the connection.'],
    ['runtime_manually_disconnected', 'Runtime environment was disconnected or replaced.'],
    ['invalid_runtime_response', 'Remote Orca runtime returned an invalid response.'],
    ['runtime_unavailable', 'Runtime is unavailable.'],
    ['runtime_error', 'Something went wrong']
  ])('reports an uncertain carry for anything not known to be unsent (%s)', (code, message) => {
    expect(classifyWorkingTreeCarryRejection(rpcError(code, message))).toBe('partially_applied')
  })

  it('reports an uncertain carry for an unclassified plain error', () => {
    expect(classifyWorkingTreeCarryRejection(new Error('host unreachable'))).toBe(
      'partially_applied'
    )
    expect(classifyWorkingTreeCarryRejection('boom')).toBe('partially_applied')
  })
})
