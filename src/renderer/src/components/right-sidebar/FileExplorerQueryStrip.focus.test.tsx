// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { FileExplorerQueryStrip } from './FileExplorerQueryStrip'
import type { RightSidebarExplorerView } from '../../../../shared/ui-chrome-types'

afterEach(cleanup)

function QueryStrip(): React.JSX.Element {
  const [view, setView] = useState<RightSidebarExplorerView>('files')
  return (
    <FileExplorerQueryStrip view={view} onSelectView={setView}>
      <div hidden={view !== 'files'}>
        <input aria-label="Name query" data-explorer-query-input="files" />
      </div>
      <div hidden={view !== 'search'}>
        <input aria-label="Content query" data-explorer-query-input="search" />
      </div>
    </FileExplorerQueryStrip>
  )
}

it('hands focused query input to the other mode in both directions and keeps each value', async () => {
  const user = userEvent.setup()
  render(<QueryStrip />)
  const names = screen.getByLabelText('Name query')
  const contents = screen.getByLabelText('Content query')
  await user.type(names, 'filename')
  await user.click(screen.getByRole('radio', { name: 'Search file contents' }))
  expect(document.activeElement).toBe(contents)
  expect(contents).toHaveProperty('value', '')
  await user.keyboard('contents')
  await user.click(screen.getByRole('radio', { name: 'Filter files by name' }))
  expect(document.activeElement).toBe(names)
  expect(names).toHaveProperty('value', 'filename')
  await user.click(screen.getByRole('radio', { name: 'Filter files by name' }))
  expect(document.activeElement).toBe(names)
  await user.click(screen.getByRole('radio', { name: 'Search file contents' }))
  expect(document.activeElement).toBe(contents)
  expect(contents).toHaveProperty('value', 'contents')
})

it('keeps focus on the switch when navigating it with the keyboard', async () => {
  const user = userEvent.setup()
  render(<QueryStrip />)
  const names = screen.getByRole('radio', { name: 'Filter files by name' })
  const contents = screen.getByRole('radio', { name: 'Search file contents' })
  await user.click(names)
  expect(document.activeElement).toBe(names)
  await user.keyboard('{ArrowRight}')
  expect(document.activeElement).toBe(contents)
  await user.keyboard(' ')
  expect(contents.getAttribute('aria-checked')).toBe('true')
  expect(document.activeElement).toBe(contents)
})
