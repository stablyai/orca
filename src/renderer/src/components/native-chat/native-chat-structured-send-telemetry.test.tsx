import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { emitNativeChatMessageSent } from './telemetry/native-chat-telemetry'
import { harness } from './native-chat-structured-composer-send.test-fixture'
import { clearNativeChatComposerDraftsForTests } from './drafts/native-chat-draft-reset'
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: vi.fn()
}))
vi.mock('./telemetry/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))
afterEach(cleanup)
it.each(['hello', '/compact', '/provider-command'])(
  'keeps %s admission distinct from provider delivery and emits once',
  async (text) => {
    clearNativeChatComposerDraftsForTests()
    vi.mocked(emitNativeChatMessageSent).mockClear()
    const { send } = harness('codex')
    await send(text, [])
    if (text === 'hello') {
      expect(emitNativeChatMessageSent).not.toHaveBeenCalled()
      return
    }
    expect(emitNativeChatMessageSent).toHaveBeenCalledExactlyOnceWith({
      agent: 'codex',
      runtime: 'local',
      backend: 'structured',
      outcome: 'unconfirmed',
      action: text.startsWith('/') ? 'command' : 'message'
    })
  }
)

it('does not count a pending or refused structured send as successful work', async () => {
  clearNativeChatComposerDraftsForTests()
  vi.mocked(emitNativeChatMessageSent).mockClear()
  const { send, structuredTransport } = harness('codex')
  let refuse!: (value: boolean) => void
  vi.mocked(structuredTransport.send).mockReturnValue(
    new Promise<boolean>((resolve) => {
      refuse = resolve
    })
  )
  const pending = send('hello', [])
  await Promise.resolve()
  expect(emitNativeChatMessageSent).not.toHaveBeenCalled()
  refuse(false)
  expect(await pending).toBe(false)
  expect(emitNativeChatMessageSent).not.toHaveBeenCalled()
})

it.each([true, false])(
  'uses renderer fallback only without host dispatch telemetry (host: %s)',
  async (supported) => {
    clearNativeChatComposerDraftsForTests()
    vi.mocked(emitNativeChatMessageSent).mockClear()
    vi.mocked(runtimeEnvironmentSupportsCapability).mockResolvedValue(supported)
    const { send, structuredTransport } = harness('codex')
    structuredTransport.runtime = 'remote'
    structuredTransport.runtimeEnvironmentId = 'old-host'
    await send('hello', [])
    await vi.waitFor(() => {
      if (supported) {
        expect(emitNativeChatMessageSent).not.toHaveBeenCalled()
      } else {
        expect(emitNativeChatMessageSent).toHaveBeenCalledExactlyOnceWith({
          agent: 'codex',
          runtime: 'remote',
          backend: 'structured',
          outcome: 'unconfirmed',
          action: 'message'
        })
      }
    })
  }
)
