// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useNativeChatComposerKeyDown } from './use-native-chat-composer-keydown'

function Composer({ send }: { send: () => void }): React.JSX.Element {
  const onKeyDown = useNativeChatComposerKeyDown({
    autocomplete: { mode: 'none' },
    mentionFiles: { files: [], loading: false, failed: false },
    completeMention: vi.fn(),
    activeSuggestion: 0,
    draft: 'hello',
    isComposing: () => false,
    completePickerItem: vi.fn(),
    dispatchPickerCommand: vi.fn(),
    dismissPicker: vi.fn(),
    interrupt: undefined,
    send,
    setActiveSuggestion: vi.fn(),
    setDraft: vi.fn(),
    setCaret: vi.fn()
  })
  return <div role="textbox" tabIndex={0} onKeyDown={onKeyDown} />
}

it('leaves Alt+Enter to the editor as a newline instead of sending', () => {
  const send = vi.fn()
  render(<Composer send={send} />)
  const notPrevented = fireEvent.keyDown(screen.getByRole('textbox'), {
    key: 'Enter',
    altKey: true
  })
  expect(send).not.toHaveBeenCalled()
  expect(notPrevented).toBe(true)
})
