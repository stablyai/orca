import { describe, expect, it } from 'vitest'

import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'

import { isRemoteExecutionHostPtyId } from './remote-execution-host-pty'

describe('isRemoteExecutionHostPtyId', () => {
  it('accepts paired-runtime ptys with and without an owner environment', () => {
    expect(isRemoteExecutionHostPtyId(toRemoteRuntimePtyId('term_1', 'env-a'))).toBe(true)
    expect(isRemoteExecutionHostPtyId(toRemoteRuntimePtyId('term_1'))).toBe(true)
  })

  it('accepts direct-SSH app pty ids', () => {
    expect(isRemoteExecutionHostPtyId(toAppSshPtyId('target-1', 'pty-1'))).toBe(true)
  })

  it('rejects local ptys, empty ids, and absent ids', () => {
    expect(isRemoteExecutionHostPtyId('worktree-1|pane-1')).toBe(false)
    expect(isRemoteExecutionHostPtyId('')).toBe(false)
    expect(isRemoteExecutionHostPtyId(null)).toBe(false)
    expect(isRemoteExecutionHostPtyId(undefined)).toBe(false)
  })

  // Why: a bare "ssh:" id with no relay separator names no connection, so it is
  // not evidence the request crosses a link.
  it('rejects an ssh-prefixed id that carries no relay pty id', () => {
    expect(isRemoteExecutionHostPtyId('ssh:target-1')).toBe(false)
  })
})
