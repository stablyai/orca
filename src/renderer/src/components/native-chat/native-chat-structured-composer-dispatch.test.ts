import { describe, expect, it, vi } from 'vitest'
import { dispatchNativeChatStructuredComposerText } from './native-chat-structured-composer-dispatch'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

function transport(): NativeChatStructuredComposerTransport {
  return {
    send: vi.fn(() => true),
    dispatchCommand: vi.fn(async () => ({ handled: false, accepted: false, error: null })),
    optionsSurface: {
      getSnapshot: () => [],
      setOption: async () => ({ ok: false, error: 'unavailable', snapshot: [] }),
      invokeAction: async () => ({ ok: false, error: 'unavailable', snapshot: [] }),
      subscribe: () => () => {}
    },
    optionSnapshot: [],
    onError: vi.fn(),
    runtime: 'local'
  }
}

describe('dispatchNativeChatStructuredComposerText', () => {
  it('binds /edit to exactly one structured-write send', async () => {
    const target = transport()
    await expect(
      dispatchNativeChatStructuredComposerText(target, '/edit update src/a.ts')
    ).resolves.toEqual({ accepted: true, error: null })
    expect(target.send).toHaveBeenCalledWith('update src/a.ts', {
      effectAuthority: 'local_structured_write'
    })
    expect(target.dispatchCommand).not.toHaveBeenCalled()
  })

  it('rejects an empty edit request without sending', async () => {
    const target = transport()
    await expect(dispatchNativeChatStructuredComposerText(target, '/edit')).resolves.toEqual({
      accepted: false,
      error: '/edit requires a source-change request.'
    })
    expect(target.send).not.toHaveBeenCalled()
  })
})
