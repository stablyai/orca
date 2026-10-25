// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { useConversationReferenceDrop } from './use-conversation-reference-drop'
import {
  CONVERSATION_REFERENCE_DRAG_TYPE,
  conversationReferenceToken,
  conversationReferenceUri
} from '../../../../shared/conversation-reference'

const reference = {
  uri: conversationReferenceUri('12345678-1234-4234-8234-123456789abc'),
  title: 'Earlier conversation',
  agent: 'claude'
}
const source = {
  source: { kind: 'transcript', agent: 'claude', sessionId: 'source-session' },
  title: reference.title,
  executionHostId: 'local'
}

function Fixture() {
  const input = useRef<NativeChatComposerInput | null>(null)
  const [value, setValue] = useState('')
  const drop = useConversationReferenceDrop({
    scope: 'conversation-drop-test',
    input,
    disabled: false,
    composing: () => false
  })
  return (
    <div ref={drop.ref} data-testid="drop" onDrop={drop.onDrop} onDragOver={drop.onDragOver}>
      <NativeChatPromptEditor
        inputRef={input}
        initialValue=""
        disabled={false}
        placeholder="Message"
        onChange={(field) => setValue(field.value)}
        onSelect={() => {}}
      />
      <output data-testid="draft">{value}</output>
      <button
        type="button"
        onClick={() => {
          input.current!.value = value
          setValue(input.current!.value)
        }}
      >
        Restore draft
      </button>
      {drop.pending ? <span>Saving reference</span> : null}
    </div>
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('conversation references in the editor', () => {
  it('drops a conversation into an atomic pill and preserves its text token', async () => {
    const create = vi.fn(async () => reference)
    vi.stubGlobal('api', { aiVault: { createConversationReference: create } })
    const screen = render(<Fixture />)
    const transfer = {
      types: [CONVERSATION_REFERENCE_DRAG_TYPE],
      getData: () => JSON.stringify(source),
      dropEffect: 'none'
    }
    await act(async () => {
      fireEvent.drop(screen.getByTestId('drop'), { dataTransfer: transfer })
    })
    await waitFor(() =>
      expect(screen.getByTestId('draft').textContent).toBe(
        `${conversationReferenceToken(reference)} `
      )
    )
    expect(
      screen.container.querySelector('[data-native-chat-conversation-reference]')?.textContent
    ).toBe(reference.title)
    expect(create).toHaveBeenCalledWith(source)
  })

  it('reconstructs a reference pill from a plain text draft', async () => {
    const field: { current: NativeChatComposerInput | null } = { current: null }
    const screen = render(
      <NativeChatPromptEditor
        inputRef={field}
        initialValue={`Compare ${conversationReferenceToken(reference)}`}
        disabled={false}
        placeholder="Message"
        onChange={() => {}}
        onSelect={() => {}}
      />
    )
    await waitFor(() => expect(field.current).not.toBeNull())
    expect(
      screen.container.querySelector('[data-native-chat-conversation-reference]')?.textContent
    ).toBe(reference.title)
    expect(field.current!.value).toBe(`Compare ${conversationReferenceToken(reference)}`)
  })
})
