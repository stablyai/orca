// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatStructuredComposerTransport } from './native-chat-structured-composer-transport'
import type { NativeChatComposerImageAttachment } from '../../attachments/chips/native-chat-image-attachment'
import { useNativeChatComposerSubmit } from './use-native-chat-composer-submit'

import { clearNativeChatComposerDraftsForTests as clearNativeChatDraftCacheForTests } from '../../drafts/native-chat-draft-reset'
import { writeNativeChatDraftCache } from '../../drafts/native-chat-draft-views'

const SCOPE = 'tab-1:pane'

afterEach(() => {
  clearNativeChatDraftCacheForTests()
})

function harness(options: {
  draft: string
  imageAttachments: NativeChatComposerImageAttachment[]
  queue: NativeChatStructuredComposerTransport['queue']
}) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture provides the submit path it exercises.
  const structuredTransport = {
    capturePresentation: () => () => true,
    onError: vi.fn(),
    onSubmitted: vi.fn(),
    send: vi.fn(() => true),
    dispatchCommand: vi.fn(async () => ({ handled: false, accepted: false, error: null })),
    queue: options.queue
  } as unknown as NativeChatStructuredComposerTransport
  const calls = {
    sendPty: vi.fn(),
    sendStructured: vi.fn(),
    setDraft: vi.fn(),
    setCaret: vi.fn()
  }
  writeNativeChatDraftCache(SCOPE, options.draft)
  const hook = renderHook(() =>
    useNativeChatComposerSubmit({
      textareaRef: { current: null },
      structuredTransport,
      draftScopeKey: SCOPE,
      draft: options.draft,
      caret: options.draft.length,
      imageAttachments: options.imageAttachments,
      disabled: false,
      ...calls
    })
  )
  return { hook, calls }
}

it.each([true, false])(
  'reverses the configured Enter delivery for the alternate shortcut (queue=%s)',
  (enabled) => {
    const attachment = { id: 'draft-image', path: '/host/image.png' }
    const { hook, calls } = harness({
      draft: 'Check the screenshot',
      imageAttachments: [attachment],
      queue: {
        capability: 'supported',
        followUpsQueue: enabled,
        isWorking: true,
        stopping: false,
        session: { queuedMessages: [] },
        prompts: []
      }
    })
    act(() => hook.result.current.send({ alternate: true }))
    expect(calls.sendStructured).toHaveBeenCalledExactlyOnceWith(
      'Check the screenshot',
      [attachment],
      {
        alternate: true
      }
    )
  }
)
