// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { FileExplorerNameFilter } from './FileExplorerNameFilter'

afterEach(cleanup)

it('turns the workspace file filter off while an outside folder is shown', () => {
  const view = render(
    <FileExplorerNameFilter query="" disabled onQueryChange={vi.fn()} onClear={vi.fn()} />
  )
  const input = screen.getByRole('textbox', { name: 'Find files' }) as HTMLInputElement

  expect(input.disabled).toBe(true)
  expect(input.placeholder).toBe('Find is not available outside the workspace')

  view.rerender(<FileExplorerNameFilter query="" onQueryChange={vi.fn()} onClear={vi.fn()} />)
  expect(input.disabled).toBe(false)
  expect(input.placeholder).toBe('Find files')
})
