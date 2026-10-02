// @vitest-environment happy-dom
import { cleanup, fireEvent, render as renderComponent, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FileExplorerScopeNotice } from './FileExplorerScopeNotice'

const render = (ui: ReactNode) => renderComponent(ui, { wrapper: TooltipProvider })
afterEach(cleanup)
const props = {
  returnRoot: null,
  onSelectRoot: vi.fn(),
  disabled: false,
  searching: false,
  sparse: true
}

it('keeps checkout guidance behind a keyboard-accessible disclosure', () => {
  render(<FileExplorerScopeNotice {...props} />)
  expect(screen.getByText('Sparse checkout')).toBeTruthy()
  expect(screen.queryByText(/The folder picker changes/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'About sparse checkout scope' }))
  expect(screen.getByText(/The folder picker changes/)).toBeTruthy()
  expect(screen.getByText(/Contents searches across the workspace/)).toBeTruthy()
})

it('labels content search scope without implying all repository files are present', () => {
  render(<FileExplorerScopeNotice {...props} searching />)
  expect(screen.getByText('Search scope: workspace files')).toBeTruthy()
  expect(screen.getAllByRole('button')).toHaveLength(1)
})

it('keeps return navigation alongside scope details and honors drag disabling', () => {
  const onSelectRoot = vi.fn()
  const returnRoot = { value: 'apps/web', label: 'apps/web' }
  const { rerender } = render(
    <FileExplorerScopeNotice {...props} returnRoot={returnRoot} onSelectRoot={onSelectRoot} />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Back to apps/web' }))
  expect(onSelectRoot).toHaveBeenCalledWith('apps/web')
  expect(screen.getByRole('button', { name: 'About sparse checkout scope' })).toBeTruthy()
  rerender(<FileExplorerScopeNotice {...props} returnRoot={returnRoot} disabled />)
  expect(screen.getByRole('button', { name: 'Back to apps/web' }).hasAttribute('disabled')).toBe(
    true
  )
})

it('adds no sparse chrome to ordinary or folder workspaces', () => {
  const { container } = render(<FileExplorerScopeNotice {...props} sparse={false} />)
  expect(container.textContent).toBe('')
})

it('places the active folder choice in the scope row and retains the return action', () => {
  render(
    <FileExplorerScopeNotice
      {...props}
      rootSelect={{
        options: [
          { value: '/', label: 'Repository root' },
          { value: 'packages/ui', label: 'packages/ui' }
        ],
        value: '/',
        disabled: false,
        onValueChange: vi.fn()
      }}
      returnRoot={{ value: 'packages/ui', label: 'packages/ui' }}
    />
  )
  expect(screen.getByRole('button', { name: 'Explorer root' }).textContent).toContain(
    'Repository root'
  )
  expect(screen.getByRole('button', { name: 'Back to packages/ui' })).toBeTruthy()
})
