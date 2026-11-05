// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { emitNativeChatMessageSent } from '@/lib/native-chat-telemetry'
import { harness } from './native-chat-structured-composer-send.test-fixture'
import { clearNativeChatComposerDraftsForTests } from './native-chat-composer-draft-store'
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))
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
