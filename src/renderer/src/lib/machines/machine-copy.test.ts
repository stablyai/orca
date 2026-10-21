import { describe, expect, it } from 'vitest'
import { isMachineConnectionError } from './machine-copy'

describe('isMachineConnectionError', () => {
  it('recognises the transport’s wording for an unreachable machine server', () => {
    expect(
      isMachineConnectionError(
        "Error invoking remote method 'runtimeEnvironments:call': Error: System SSH port forward failed (exit 255)"
      )
    ).toBe(true)
    expect(isMachineConnectionError('Runtime environment is manually disconnected.')).toBe(true)
    expect(isMachineConnectionError('node-pty: posix_spawn failed: ENOENT')).toBe(false)
  })
})
