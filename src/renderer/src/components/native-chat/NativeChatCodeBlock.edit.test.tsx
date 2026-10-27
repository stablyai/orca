// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeChatCodeBlock, NativeChatPlainCodeBlock } from './NativeChatCodeBlock'
import {
  clearNativeChatComposerDraftsForTests,
  structuredAgentSessionDraftScopeKey
} from './native-chat-composer-draft-store'
import { readNativeChatDraftCache, writeNativeChatDraftCache } from './native-chat-draft-cache'
import {
  NativeChatVisualOwnerContext,
  NativeChatVisualEditingContext,
  type NativeChatVisualOwner
} from './native-chat-visual-owner'

const OWNER: NativeChatVisualOwner = {
  target: { kind: 'local' },
  sessionId: 'session-1',
  worktreeId: 'repo::/work'
}
const SCOPE = structuredAgentSessionDraftScopeKey(OWNER.sessionId)

afterEach(() => {
  cleanup()
  clearNativeChatComposerDraftsForTests()
})

function inChat(node: React.ReactNode): React.JSX.Element {
  return (
    <NativeChatVisualOwnerContext.Provider value={OWNER}>
      {node}
    </NativeChatVisualOwnerContext.Provider>
  )
}

describe('NativeChatCodeBlock editing', () => {
  it('puts the edited block into the chat message as a fence in its language', () => {
    render(
      inChat(
        <NativeChatCodeBlock language="latex">
          <code>{'We propose X.\n'}</code>
        </NativeChatCodeBlock>
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Edited code' }), {
      target: { value: 'We propose Y.\n' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add to message' }))

    expect(readNativeChatDraftCache(SCOPE)).toBe('```latex\nWe propose Y.\n```')
    expect(screen.queryByRole('textbox', { name: 'Edited code' })).toBeNull()
    expect(screen.getByText('We propose X.', { exact: false })).toBeInTheDocument()
  })

  it('leaves the message alone when the edit is cancelled', () => {
    render(
      inChat(
        <NativeChatCodeBlock>
          <code>{'draft\n'}</code>
        </NativeChatCodeBlock>
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edited code' }), { key: 'Escape' })

    expect(readNativeChatDraftCache(SCOPE)).toBe('')
    expect(screen.queryByRole('textbox', { name: 'Edited code' })).toBeNull()
    // An explicit exit hands the keyboard back to the Edit button.
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus()
  })

  it('offers no edit outside a chat or on a dimmed row', () => {
    render(
      <NativeChatCodeBlock language="text">
        <code>{'a\n'}</code>
      </NativeChatCodeBlock>
    )
    render(
      inChat(
        <NativeChatPlainCodeBlock language="text">
          <code>{'b\n'}</code>
        </NativeChatPlainCodeBlock>
      )
    )

    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  it('offers no edit on a user message', () => {
    render(
      inChat(
        <NativeChatCodeBlock language="text" editable={false}>
          <code>{'a\n'}</code>
        </NativeChatCodeBlock>
      )
    )

    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  it('always appends the added block, even over a duplicate or a lone /clear', () => {
    const fence = '```latex\nWe propose Y.\n```'
    render(
      inChat(
        <NativeChatCodeBlock language="latex">
          <code>{'We propose Y.\n'}</code>
        </NativeChatCodeBlock>
      )
    )

    writeNativeChatDraftCache(SCOPE, fence)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add to message' }))
    expect(readNativeChatDraftCache(SCOPE)).toBe(`${fence}\n\n${fence}`)

    writeNativeChatDraftCache(SCOPE, '/clear')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add to message' }))
    expect(readNativeChatDraftCache(SCOPE)).toBe(`/clear\n\n${fence}`)
  })

  it('offers no edit in a dimmed split group', () => {
    render(
      inChat(
        <NativeChatVisualEditingContext.Provider value={false}>
          <NativeChatCodeBlock language="text">
            <code>{'a\n'}</code>
          </NativeChatCodeBlock>
        </NativeChatVisualEditingContext.Provider>
      )
    )

    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  it('closes on Escape wherever the editor focus sits', () => {
    render(
      inChat(
        <NativeChatCodeBlock>
          <code>{'draft\n'}</code>
        </NativeChatCodeBlock>
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    screen.getByRole('button', { name: 'Cancel' }).focus()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' })

    expect(screen.queryByRole('textbox', { name: 'Edited code' })).toBeNull()
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
  })
})
