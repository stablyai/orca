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

type EditSessionArgs = Parameters<typeof useNativeChatComposerEditSession>[0]
const noop = (): void => {}

function notesBlocked(options: { disabled?: boolean; acceptsImages?: boolean }) {
  const ref = createRef<NativeChatComposerHandle>()
  const own: NativeChatComposerHandle = {
    insertAgentReferences: () => false,
    focus: () => true,
    insertTypedText: () => false,
    acceptsText: () => true,
    appendText: noop,
    handlePasteEvent: noop,
    pasteFromClipboard: noop,
    contains: () => false
  }
  const transport = { acceptsImages: options.acceptsImages, optionSnapshot: [] }
  renderHook(() =>
    useNativeChatComposerEditSession({
      editSession: undefined,
      root: { current: null },
      handle: { current: own },
      ref,
      draftScopeKey: 'agent-session:notes-blocked',
      agent: 'claude',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test stub; outside an edit the hook reads only acceptsImages and optionSnapshot of the transport.
      structuredTransport: transport as unknown as NativeChatStructuredComposerTransport,
      sendStructured: noop,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test stub; the picker dispatch that reads it is mocked above.
      ptyCommandRouting: {} as EditSessionArgs['ptyCommandRouting'],
      setNotice: noop,
      disabled: options.disabled ?? false,
      sendHeld: false,
      submission: { send: noop, messageDelivery: true },
      peekSendClassification: () => 'chat',
      completeItem: noop
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
