// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { InlineInputRow } from './file-explorer-inline-input-row'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('previews copied text and pastes into the selected part of a filename', async () => {
  vi.stubGlobal('api', { ui: { readClipboardText: async () => 'release' } })
  const submit = vi.fn()
  const view = render(
    <InlineInputRow
      depth={0}
      inlineInput={{ type: 'rename', parentPath: '/repo', depth: 0, existingName: 'draft.md' }}
      onSubmit={submit}
      onCancel={() => {}}
    />
  )
  const input = screen.getByRole<HTMLInputElement>('textbox')
  await waitFor(() => expect(input.selectionEnd).toBe(5))
  fireEvent.contextMenu(input)
  const paste = await view.findByRole('menuitem', { name: /^Paste/ })
  fireEvent.pointerEnter(paste, { pointerType: 'mouse' })
  fireEvent.pointerOver(paste, { pointerType: 'mouse' })
  await view.findByText('release')
  fireEvent.click(paste)
  await waitFor(() => expect(input.value).toBe('release.md'))
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(submit).toHaveBeenCalledWith('release.md')
})
