import { describe, expect, it, vi } from 'vitest'
import {
  parseAuthenticatedFrame,
  parseReadyFrame,
  parseRemoteRuntimeRpcFrame,
  REMOTE_RUNTIME_JSON_STRUCTURE_LIMITS
} from './remote-runtime-request-frames'

describe('remote runtime JSON frame admission', () => {
  it('preserves valid handshake and RPC frames', () => {
    expect(parseReadyFrame('{"type":"e2ee_ready"}')).toBeNull()
    expect(parseAuthenticatedFrame('{"type":"e2ee_authenticated"}')).toBeNull()
    expect(parseRemoteRuntimeRpcFrame('{"_keepalive":true}')).toEqual({ type: 'keepalive' })
  })

  it('rejects excessive nesting before JSON.parse', () => {
    const parseSpy = vi.spyOn(JSON, 'parse')
    try {
      const depth = REMOTE_RUNTIME_JSON_STRUCTURE_LIMITS.nestingDepth + 1
      const amplified = `${'['.repeat(depth)}0${']'.repeat(depth)}`

      expect(parseReadyFrame(amplified)).toMatchObject({
        code: 'invalid_runtime_response'
      })
      expect(parseSpy).not.toHaveBeenCalled()
    } finally {
      parseSpy.mockRestore()
    }
  })
})
