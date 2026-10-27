import { describe, expect, it } from 'vitest'

import { toRemoteRuntimePtyId } from './remote-runtime/remote-runtime-pty-id'
import { toAppSshPtyId } from './ssh-pty-id'

import { isRemoteExecutionHostPtyId } from './remote-execution-host-pty-id'

describe('isRemoteExecutionHostPtyId', () => {
  it('accepts paired-runtime ptys with and without an owner environment', () => {
    expect(isRemoteExecutionHostPtyId(toRemoteRuntimePtyId('term_1', 'env-a'))).toBe(true)
    expect(isRemoteExecutionHostPtyId(toRemoteRuntimePtyId('term_1'))).toBe(true)
  })

  // Why: decoding fails on a malformed owner, but the id still names a remote pty.
  it('keeps a malformed or newer-format remote id remote', () => {
    expect(isRemoteExecutionHostPtyId('remote:%E0%A4%A@@term_1')).toBe(true)
    expect(isRemoteExecutionHostPtyId('remote:v2|env|term_1')).toBe(true)
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

  // An ssh prefix without a relay PTY separator proves no remote connection.
  it('rejects an ssh-prefixed id that carries no relay pty id', () => {
    expect(isRemoteExecutionHostPtyId('ssh:target-1')).toBe(false)
  })
})
