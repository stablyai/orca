// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorktreeTitleInlineRename } from './WorktreeTitleInlineRename'

afterEach(cleanup)

it('displays the repository prefix without including it in the editable name', async () => {
  const onRename = vi.fn()
  render(
    <WorktreeTitleInlineRename displayName="Child" titlePrefix="frontend/" onRename={onRename} />
  )
  fireEvent.doubleClick(screen.getByText('frontend/Child'))
  const input = screen.getByRole<HTMLInputElement>('textbox')
  expect(input.value).toBe('Child')
  fireEvent.change(input, { target: { value: 'New name' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(onRename).toHaveBeenCalledWith('New name'))
})
