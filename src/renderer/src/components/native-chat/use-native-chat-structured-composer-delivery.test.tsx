// @vitest-environment happy-dom
import { cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { ATTACHMENT, harness } from './use-native-chat-structured-composer-send.test-fixture'

vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))
afterEach(() => {
  cleanup()
  clearNativeChatComposerDraftsForTests()
})

describe('queued and immediate composer delivery', () => {
  it.each(['unknown', 'unsupported'] as const)(
    'retains the default busy queue draft when support is %s',
    async (capability) => {
      const { send, structuredTransport, setDraft } = harness('codex')
      structuredTransport.queue = {
        followUpsQueue: true,
        capability,
        isWorking: true,
        stopping: false,
        session: { queuedMessages: [] },
        prompts: []
      }
      structuredTransport.isWorking = true
      updateNativeChatComposerDraft(
        'tab-1:pane',
        { text: 'Keep for later', images: [ATTACHMENT] },
        'immediate'
      )
      await send('Keep for later', [ATTACHMENT])
      expect(structuredTransport.send).not.toHaveBeenCalled()
      expect(setDraft).not.toHaveBeenCalled()
      expect(readNativeChatComposerDraft('tab-1:pane')).toMatchObject({
        text: 'Keep for later',
        images: [ATTACHMENT]
      })
      expect(structuredTransport.onError).toHaveBeenCalledWith(
        expect.stringContaining('cannot queue drafts yet')
      )
    }
  )
  it.each(['unknown', 'unsupported'] as const)(
    'keeps an explicit queued draft when queue support is %s',
    async (capability) => {
      const { send, structuredTransport, setDraft } = harness('codex')
      structuredTransport.queue = {
        followUpsQueue: false,
        capability,
        isWorking: true,
        stopping: false,
        session: { queuedMessages: [] },
        prompts: []
      }
      updateNativeChatComposerDraft(
        'tab-1:pane',
        { text: 'Keep for later', images: [ATTACHMENT] },
        'immediate'
      )
      await send('Keep for later', [ATTACHMENT], { delivery: 'queue-if-active' })
      expect(structuredTransport.send).not.toHaveBeenCalled()
      expect(setDraft).not.toHaveBeenCalled()
      expect(readNativeChatComposerDraft('tab-1:pane')).toMatchObject({
        text: 'Keep for later',
        images: [ATTACHMENT]
      })
      expect(structuredTransport.onError).toHaveBeenCalledWith(
        expect.stringContaining('cannot queue drafts yet')
      )
    }
  )

  it('steers the same complete text/image draft and clears it only after acceptance', async () => {
    const { send, structuredTransport } = harness('codex')
    updateNativeChatComposerDraft(
      'tab-1:pane',
      { text: 'inspect this', images: [ATTACHMENT] },
      'immediate'
    )
    await send('inspect this', [ATTACHMENT], { delivery: 'immediate' })
    expect(structuredTransport.send).toHaveBeenCalledExactlyOnceWith('inspect this', [ATTACHMENT], {
      delivery: 'immediate'
    })
    expect(readNativeChatComposerDraft('tab-1:pane').images).toEqual([])
  })

  it.each(['unknown', 'unsupported'] as const)(
    'retains the full draft when steering is %s on this host',
    async (capability) => {
      const { send, structuredTransport, setDraft } = harness('codex')
      structuredTransport.steerCapability = capability
      updateNativeChatComposerDraft(
        'tab-1:pane',
        { text: 'inspect this', images: [ATTACHMENT] },
        'immediate'
      )
      await send('inspect this', [ATTACHMENT], { delivery: 'immediate' })
      expect(structuredTransport.send).not.toHaveBeenCalled()
      expect(setDraft).not.toHaveBeenCalled()
      expect(readNativeChatComposerDraft('tab-1:pane')).toMatchObject({
        text: 'inspect this',
        images: [ATTACHMENT]
      })
      expect(structuredTransport.onError).toHaveBeenCalledWith(
        expect.stringContaining('cannot send drafts immediately yet')
      )
    }
  )
})
