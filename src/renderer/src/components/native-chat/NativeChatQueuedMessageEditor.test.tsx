// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatQueuedMessageEditor } from './NativeChatQueuedMessageEditor'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import type { QueuedMessageInlineEditor } from './use-structured-agent-session-queued-edit'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values?.[name] ?? '')
}))
afterEach(cleanup)
function editor(): QueuedMessageInlineEditor {
  return {
    messageId: 'mail',
    text: 'full message',
    acquiring: false,
    saving: false,
    canSave: true,
    change: vi.fn(),
    save: vi.fn(),
    cancel: vi.fn()
  }
}
function view(
  edit: QueuedMessageInlineEditor,
  prompt: 'question' | 'approval' | null,
  answer = vi.fn(),
  promptCancel = vi.fn()
) {
  return (
    <div data-native-chat-root="true">
      <ul>
        <li>
          <NativeChatQueuedMessageEditor editor={edit} />
        </li>
      </ul>
      {prompt === 'approval' ? (
        <NativeChatApprovalCard
          approval={{
            title: 'Allow command?',
            options: [{ label: 'Allow', send: 'allow' }]
          }}
          onChoose={answer}
          onCancel={promptCancel}
          shouldFocus
        />
      ) : null}
      {prompt === 'question' ? (
        <NativeChatQuestionCard
          prompt={{
            questions: [
              {
                question: 'Which?',
                options: [{ label: 'One' }],
                multiSelect: false
              }
            ]
          }}
          onAnswer={answer}
          onCancel={promptCancel}
          shouldFocus
        />
      ) : null}
    </div>
  )
}
describe('queued card textarea', () => {
  it.each(['question', 'approval'] as const)(
    'stays mounted and focused when a %s opens, its keys apart from the prompt',
    (prompt) => {
      const edit = editor()
      const answer = vi.fn()
      const promptCancel = vi.fn()
      const { rerender } = render(view(edit, null, answer, promptCancel))
      const field = screen.getByRole('textbox', { name: 'Edit message' })
      expect(document.activeElement).toBe(field)
      rerender(view(edit, prompt, answer, promptCancel))
      expect(document.activeElement).toBe(field)
      fireEvent.keyDown(field, { key: 'Enter' })
      expect(edit.save).toHaveBeenCalledOnce()
      expect(answer).not.toHaveBeenCalled()
      fireEvent.keyDown(field, { key: 'Escape' })
      expect(edit.cancel).toHaveBeenCalledOnce()
      expect(promptCancel).not.toHaveBeenCalled()
    }
  )
  it.each(['question', 'approval'] as const)(
    'focuses and saves with a %s already open',
    (prompt) => {
      const edit = editor()
      render(view(edit, prompt))
      const field = screen.getByRole('textbox', { name: 'Edit message' })
      expect(document.activeElement).toBe(field)
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(edit.save).toHaveBeenCalledOnce()
    }
  )
  it('Enter and the platform modifier save, Shift+Enter is a newline and handled keys do not bubble', () => {
    const edit = editor()
    const parent = vi.fn()
    render(
      <div onKeyDown={parent}>
        <NativeChatQueuedMessageEditor editor={edit} />
      </div>
    )
    const field = screen.getByRole('textbox')
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(edit.save).toHaveBeenCalledOnce()
    expect(parent).not.toHaveBeenCalled()
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true })
    expect(edit.save).toHaveBeenCalledOnce()
    for (const [platform, modifier] of [
      ['Macintosh', { metaKey: true }],
      ['Linux', { ctrlKey: true }],
      ['Windows', { ctrlKey: true }]
    ] as const) {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform)
      fireEvent.keyDown(field, { key: 'Enter', ...modifier })
    }
    expect(edit.save).toHaveBeenCalledTimes(4)
    vi.restoreAllMocks()
  })
  it('IME confirmation and Escape never commit/cancel or reach the prompt', () => {
    const edit = editor()
    const parent = vi.fn()
    render(
      <div onKeyDown={parent}>
        <NativeChatQueuedMessageEditor editor={edit} />
      </div>
    )
    const field = screen.getByRole('textbox')
    fireEvent.compositionStart(field)
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(field, { key: 'Escape', isComposing: true })
    fireEvent.compositionEnd(field)
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 })
    expect(edit.save).not.toHaveBeenCalled()
    expect(edit.cancel).not.toHaveBeenCalled()
    expect(parent).not.toHaveBeenCalled()
  })
  it('acquisition seeds a read-only field with the X always usable', () => {
    const edit = { ...editor(), acquiring: true }
    render(<NativeChatQueuedMessageEditor editor={edit} />)
    expect(screen.getByRole('textbox').getAttribute('readonly')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }))
    expect(edit.cancel).toHaveBeenCalledOnce()
  })
  it('the header X cancels and saves nothing; Save is the only footer action', () => {
    const edit = editor()
    render(<NativeChatQueuedMessageEditor editor={edit} />)
    expect(screen.getByText('Editing message')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }))
    expect(edit.cancel).toHaveBeenCalledOnce()
    expect(edit.save).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    expect(
      screen
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label') ?? button.textContent)
    ).toEqual(['Cancel editing', 'Save'])
  })
  it.each([
    { state: 'saving', edit: { saving: true } },
    { state: 'unchanged', edit: { canSave: false } }
  ])('Save is disabled while $state and enabled otherwise', ({ edit: overrides }) => {
    const edit = { ...editor(), ...overrides }
    const { rerender } = render(<NativeChatQueuedMessageEditor editor={edit} />)
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save.hasAttribute('disabled')).toBe(true)
    fireEvent.click(save)
    expect(edit.save).not.toHaveBeenCalled()
    rerender(<NativeChatQueuedMessageEditor editor={{ ...edit, saving: false, canSave: true }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(edit.save).toHaveBeenCalledOnce()
  })
  it('Save carries a decorative Enter badge and no key hint text', () => {
    for (const platform of ['Macintosh', 'Windows']) {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform)
      const { container, unmount } = render(<NativeChatQueuedMessageEditor editor={editor()} />)
      const save = screen.getByRole('button', { name: 'Save' })
      const badge = save.querySelector('[aria-hidden="true"]')
      expect(badge?.querySelector('svg')).toBeTruthy()
      expect(badge?.textContent).toBe('')
      expect(container.textContent).not.toMatch(/Shift|⇧|new line/)
      unmount()
    }
    vi.restoreAllMocks()
  })
})
