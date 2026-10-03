// @vitest-environment happy-dom
import { act } from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/react'
import { Rich, source, renderMarkdown, setOutput } from './native-markdown-render-test-fixture'
describe('rich Markdown native providers', () => {
  it('renders rich NodeView output beneath editable source without changing Markdown', async () => {
    let editor: Editor | undefined
    const openReference = vi.fn()
    const view = render(
      <Rich
        context={{ source, openReference }}
        onEditor={(value) => {
          editor = value
        }}
      />
    )
    await waitFor(() => expect(view.container.querySelector('table')).not.toBeNull())
    expect(view.container.querySelector('pre')?.textContent).toBe('TABLE title')
    expect(
      view.container.querySelector('[data-native-markdown-output]')?.getAttribute('contenteditable')
    ).toBe('false')
    expect(editor?.getMarkdown()).toBe('```query\nTABLE title\n```')
    fireEvent.click(view.getByRole('button', { name: '<img src=x onerror=alert(1)>' }))
    expect(openReference).toHaveBeenCalledWith(
      { path: 'notes/one.md', base: 'workspace' },
      expect.objectContaining({ documentPath: source.filePath, workspacePath: '/repo' })
    )
    await act(async () => {
      editor?.commands.insertContentAt(1, 'new ')
    })
    await waitFor(() => expect(renderMarkdown.mock.calls.at(-1)?.[0].code).toBe('new TABLE title'))
    expect(editor?.getMarkdown()).toBe('```query\nnew TABLE title\n```')
  })

  it.each(['mermaid', 'typescript', ''])(
    'preserves ordinary rich fence %s and Mermaid without invoking a provider',
    async (language) => {
      const view = render(
        <Rich
          language={language}
          context={{ source, openReference: vi.fn() }}
          onEditor={() => {}}
        />
      )
      await waitFor(() => expect(view.container.querySelector('pre')).not.toBeNull())
      expect(renderMarkdown).not.toHaveBeenCalled()
      expect(view.container.querySelector('[data-native-markdown-output]')).toBeNull()
    }
  )
  it.each([
    { kind: 'list', items: [{ text: 'Rich list' }] },
    { kind: 'error', message: 'Rich query failed' }
  ])('renders semantic $kind beneath rich source', async (value) => {
    setOutput(value)
    const view = render(<Rich context={{ source, openReference: vi.fn() }} onEditor={() => {}} />)
    await waitFor(() =>
      expect(view.container.querySelector('[data-native-markdown-output]')).not.toBeNull()
    )
    expect(view.container.querySelector('pre')?.textContent).toBe('TABLE title')
    expect(view.container.textContent).toContain(
      value.kind === 'list' ? 'Rich list' : 'Rich query failed'
    )
  })
})
