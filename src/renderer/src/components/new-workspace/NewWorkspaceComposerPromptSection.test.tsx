// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewWorkspaceComposerPromptSection } from './NewWorkspaceComposerPromptSection'

afterEach(cleanup)

function renderPrompt(
  overrides: Partial<React.ComponentProps<typeof NewWorkspaceComposerPromptSection>> = {}
): { prompt: HTMLTextAreaElement; onCreate: ReturnType<typeof vi.fn> } {
  const onCreate = vi.fn()
  render(
    <NewWorkspaceComposerPromptSection
      agentPrompt=""
      onAgentPromptChange={vi.fn()}
      quickAgent="claude"
      createDisabled={false}
      onCreate={onCreate}
      toolbar={null}
      {...overrides}
    />
  )
  return { prompt: screen.getByRole<HTMLTextAreaElement>('textbox'), onCreate }
}

describe('NewWorkspaceComposerPromptSection', () => {
  it('emits typed text', () => {
    const onAgentPromptChange = vi.fn()
    const { prompt } = renderPrompt({ onAgentPromptChange })
    fireEvent.change(prompt, { target: { value: 'fix the flaky test' } })
    expect(onAgentPromptChange).toHaveBeenCalledWith('fix the flaky test')
  })

  it('submits on plain Enter', () => {
    const { prompt, onCreate } = renderPrompt()
    fireEvent.keyDown(prompt, { key: 'Enter' })
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['Shift', { shiftKey: true }],
    ['Cmd', { metaKey: true }],
    ['Ctrl', { ctrlKey: true }],
    ['Alt', { altKey: true }],
    ['IME', { isComposing: true }]
  ])('does not submit on %s+Enter', (_label, modifiers) => {
    const { prompt, onCreate } = renderPrompt()
    fireEvent.keyDown(prompt, { key: 'Enter', ...modifiers })
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('does not submit while creation is disabled', () => {
    const { prompt, onCreate } = renderPrompt({ createDisabled: true })
    fireEvent.keyDown(prompt, { key: 'Enter' })
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('takes focus from the name input once an agent is picked', () => {
    const props = {
      agentPrompt: '',
      createDisabled: false,
      onCreate: vi.fn(),
      toolbar: <input data-workspace-name-input="true" aria-label="Name" />
    }
    const { rerender } = render(<NewWorkspaceComposerPromptSection {...props} quickAgent={null} />)
    screen.getByLabelText('Name').focus()
    rerender(<NewWorkspaceComposerPromptSection {...props} quickAgent="claude" />)
    expect(document.activeElement).toBe(screen.getByLabelText('Prompt'))
  })

  it('leaves focus the user moved elsewhere when an agent is picked', () => {
    const props = {
      agentPrompt: '',
      createDisabled: false,
      onCreate: vi.fn(),
      toolbar: <button type="button">Agent</button>
    }
    const { rerender } = render(<NewWorkspaceComposerPromptSection {...props} quickAgent={null} />)
    screen.getByRole('button', { name: 'Agent' }).focus()
    rerender(<NewWorkspaceComposerPromptSection {...props} quickAgent="claude" />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Agent' }))
  })

  it('is disabled without an agent', () => {
    expect(renderPrompt({ quickAgent: null }).prompt.disabled).toBe(true)
  })
})
