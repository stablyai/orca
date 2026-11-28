// @vitest-environment happy-dom
// What the message box tells image notes about itself: a box that takes no input now, or a chat
// that takes no images, has nowhere to put the marked copy.
import { renderHook } from '@testing-library/react'
import { createRef } from 'react'
import { expect, it, vi } from 'vitest'
import type { NativeChatComposerHandle } from '../../composer/native-chat-composer-types'
import type { NativeChatStructuredComposerTransport } from '../../composer/submit/native-chat-structured-composer-transport'
import { useNativeChatComposerEditSession } from './use-native-chat-composer-edit-session'

vi.mock('../../composer/pickers/use-native-chat-picker-command-dispatch', () => ({
  useNativeChatPickerCommandDispatch: () => () => {}
}))

function notesBlocked(options: { disabled?: boolean; acceptsImages?: boolean }) {
  const ref = createRef<NativeChatComposerHandle>()
  const handle = { current: {} as NativeChatComposerHandle }
  renderHook(() =>
    useNativeChatComposerEditSession({
      editSession: undefined,
      root: { current: null },
      handle,
      ref,
      draftScopeKey: 'agent-session:notes-blocked',
      agent: 'claude',
      structuredTransport: {
        acceptsImages: options.acceptsImages,
        optionSnapshot: []
      } as unknown as NativeChatStructuredComposerTransport,
      sendStructured: () => {},
      ptyCommandRouting: {} as Parameters<
        typeof useNativeChatComposerEditSession
      >[0]['ptyCommandRouting'],
      setNotice: () => {},
      disabled: options.disabled ?? false,
      sendHeld: false,
      submission: { send: () => {}, messageDelivery: true },
      peekSendClassification: () => 'message' as never,
      completeItem: () => {}
    })
  )
  return ref.current?.notesBlocked?.()
}

it('a message box that takes no input now has nowhere for notes', () => {
  expect(notesBlocked({ disabled: true })).toBe('unavailable')
})

it('a chat that takes no images has nowhere for a marked copy', () => {
  expect(notesBlocked({ acceptsImages: false })).toBe('images')
})

it('a chat that takes messages and images takes notes', () => {
  expect(notesBlocked({})).toBeNull()
})
