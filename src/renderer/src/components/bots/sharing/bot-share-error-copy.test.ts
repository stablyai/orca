import { describe, expect, it } from 'vitest'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import type { RuntimeRpcFailure } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import {
  SHARING_UNAVAILABLE_ON_HOST_CODE,
  SHARING_UNAVAILABLE_ON_HOST_MESSAGE
} from '../../../../../shared/remote-runtime/host-status/sharing-unavailable-on-host'
import { botShareErrorMessage } from './bot-share-error-copy'

const GENERIC = 'Something went wrong. Try again.'

describe('botShareErrorMessage', () => {
  it('names the headless host that refused the share', () => {
    // A bot on a paired headless server: the server refuses to publish without Orca Cloud.
    const failure: RuntimeRpcFailure = {
      id: 'peer-rpc',
      ok: false,
      error: {
        code: SHARING_UNAVAILABLE_ON_HOST_CODE,
        message: SHARING_UNAVAILABLE_ON_HOST_MESSAGE
      },
      _meta: { runtimeId: 'runtime-1' }
    }

    const message = botShareErrorMessage(new RuntimeRpcCallError(failure))

    expect(message).not.toBe(GENERIC)
    expect(message).toContain('headless')
  })

  it('keeps the generic line for a failure it cannot name', () => {
    const failure: RuntimeRpcFailure = {
      id: 'peer-rpc',
      ok: false,
      error: { code: 'runtime_error', message: 'Something failed inside the host.' },
      _meta: { runtimeId: 'runtime-1' }
    }

    expect(botShareErrorMessage(new RuntimeRpcCallError(failure))).toBe(GENERIC)
  })
})
