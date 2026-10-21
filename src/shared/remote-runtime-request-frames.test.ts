import { describe, expect, it, vi } from 'vitest'
import { createRemoteRuntimeClientHandshake } from './remote-runtime-client-handshake'
import {
  parseRemoteRuntimeRpcFrame,
  remoteRuntimeAuthReplyError,
  remoteRuntimeReadyError,
  REMOTE_RUNTIME_JSON_STRUCTURE_LIMITS
} from './remote-runtime-request-frames'

const HOST_PUBLIC_KEY_B64 = Buffer.alloc(32, 9).toString('base64')

describe('remote runtime JSON frame admission', () => {
  it('preserves valid handshake and RPC frames', () => {
    const handshake = createRemoteRuntimeClientHandshake(HOST_PUBLIC_KEY_B64)
    expect(remoteRuntimeReadyError(handshake.acceptReadyText('{"type":"e2ee_ready"}'))).toBeNull()
    expect(
      remoteRuntimeAuthReplyError(handshake.classifyAuthReply('{"type":"e2ee_authenticated"}'))
    ).toBeNull()
    expect(parseRemoteRuntimeRpcFrame('{"_keepalive":true}')).toEqual({ type: 'keepalive' })
  })

  it('rejects excessive nesting before JSON.parse', () => {
    const handshake = createRemoteRuntimeClientHandshake(HOST_PUBLIC_KEY_B64)
    const parseSpy = vi.spyOn(JSON, 'parse')
    try {
      const depth = REMOTE_RUNTIME_JSON_STRUCTURE_LIMITS.nestingDepth + 1
      const amplified = `${'['.repeat(depth)}0${']'.repeat(depth)}`

      expect(remoteRuntimeReadyError(handshake.acceptReadyText(amplified))).toMatchObject({
        code: 'invalid_runtime_response'
      })
      expect(parseSpy).not.toHaveBeenCalled()
    } finally {
      parseSpy.mockRestore()
    }
  })
})
