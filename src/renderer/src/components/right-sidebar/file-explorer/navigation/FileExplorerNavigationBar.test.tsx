// @vitest-environment happy-dom
import { cleanup, fireEvent, render as renderComponent, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FileExplorerNavigationBar } from './FileExplorerNavigationBar'

const render = (ui: ReactNode) => renderComponent(ui, { wrapper: TooltipProvider })
afterEach(cleanup)

it('navigates with Up, Open Folder, and breadcrumb ancestors', () => {
  const onNavigate = vi.fn()
  const onUp = vi.fn()
  const onOpenFolder = vi.fn()
  render(
    <FileExplorerNavigationBar
      navigation={{
        breadcrumbs: [
          { label: '/', path: '/' },
          { label: 'tmp', path: '/tmp' },
          { label: 'reference', path: '/tmp/reference' }
        ],
        outsideWorkspace: true,
        localOnlyDisabled: false,
        onNavigate,
        onUp,
        onOpenFolder,
        onBackToWorkspace: vi.fn()
      }}
    />
  )

  fireEvent.click(screen.getByRole('button', { name: 'Up' }))
  fireEvent.click(screen.getByRole('button', { name: 'Open Folder…' }))
  fireEvent.click(screen.getByRole('button', { name: 'tmp' }))
  expect(onUp).toHaveBeenCalledOnce()
  expect(onOpenFolder).toHaveBeenCalledOnce()
  expect(onNavigate).toHaveBeenCalledWith('/tmp')
})

it('renders POSIX root without a duplicated separator', () => {
  const { container } = render(
    <FileExplorerNavigationBar
      navigation={{
        breadcrumbs: [
          { label: '/', path: '/' },
          { label: 'tmp', path: '/tmp' }
        ],
        outsideWorkspace: false,
        localOnlyDisabled: false,
        onNavigate: vi.fn(),
        onUp: vi.fn(),
        onOpenFolder: vi.fn(),
        onBackToWorkspace: vi.fn()
      }}
    />
  )

  // Why: root button already renders "/", so there must be no additional separator between "/" and "tmp".
  const separatorElements = Array.from(container.querySelectorAll('span')).filter(
    (el) => el.textContent === '/'
  )
  expect(separatorElements).toHaveLength(0)
  expect(screen.getByRole('button', { name: '/' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'tmp' })).toBeTruthy()
})

it('collapses leading segments into ellipsis for deep paths while keeping current folder', () => {
  render(
    <FileExplorerNavigationBar
      navigation={{
        breadcrumbs: [
          { label: '/', path: '/' },
          { label: 'private', path: '/private' },
          { label: 'tmp', path: '/private/tmp' },
          { label: 'current-project', path: '/private/tmp/current-project' }
        ],
        outsideWorkspace: true,
        localOnlyDisabled: false,
        onNavigate: vi.fn(),
        onUp: vi.fn(),
        onOpenFolder: vi.fn(),
        onBackToWorkspace: vi.fn()
      }}
    />
  )

  expect(screen.getByRole('button', { name: '/' })).toBeTruthy()
  expect(screen.getByText('…')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'current-project' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'private' })).toBeNull()
})

it('shows shortened notice text outside and disables navigation with a Local only hint remotely', () => {
  const onBackToWorkspace = vi.fn()
  render(
    <FileExplorerNavigationBar
      navigation={{
        breadcrumbs: [{ label: '/repo', path: '/repo' }],
        outsideWorkspace: true,
        localOnlyDisabled: true,
        onNavigate: vi.fn(),
        onUp: vi.fn(),
        onOpenFolder: vi.fn(),
        onBackToWorkspace
      }}
    />
  )

  expect(screen.getByText('Local only')).toBeTruthy()
  expect(screen.getByText('Outside the workspace · read-only')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Up' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: 'Open Folder…' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Back to workspace' }))
  expect(onBackToWorkspace).toHaveBeenCalledOnce()
})
