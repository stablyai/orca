// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CsvCellValue } from './CsvCellValue'
import { openCsvHttpLink } from './csv-link-routing'

const { openHttpLink, getConnectionIdForFile } = vi.hoisted(() => ({
  openHttpLink: vi.fn(),
  getConnectionIdForFile: vi.fn((): string | null | undefined => null)
}))
vi.mock('@/lib/http-link-routing', () => ({ openHttpLink }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('opens a whole-cell URL without navigating the renderer or changing its displayed text', () => {
  const onOpenUrl = vi.fn()
  render(<CsvCellValue value=" https://example.com/a?q=b#section " onOpenUrl={onOpenUrl} />)
  const link = screen.getByRole('link')
  expect(link.textContent).toBe(' https://example.com/a?q=b#section ')
  expect(link.getAttribute('href')).toBe('https://example.com/a?q=b#section')
  expect(fireEvent.click(link)).toBe(false)
  expect(onOpenUrl).toHaveBeenCalledWith('https://example.com/a?q=b#section', expect.anything())
  fireEvent(link, new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }))
  expect(onOpenUrl).toHaveBeenCalledTimes(2)
})

it.each([
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'file:///tmp/example.csv',
  'https://',
  'https://[broken',
  'See https://example.com for details',
  '<a href="https://example.com">click</a>'
])('keeps non-URLs and executable content as literal text: %s', (value) => {
  render(<CsvCellValue value={value} onOpenUrl={vi.fn()} />)
  expect(screen.queryByRole('link')).toBeNull()
  expect(screen.getByText(value)).toBeTruthy()
})

it('keeps HTTP and localhost URLs clickable', () => {
  render(<CsvCellValue value="HTTP://localhost:3000/demo" onOpenUrl={vi.fn()} />)
  expect(screen.getByRole('link').getAttribute('href')).toBe('http://localhost:3000/demo')
})

it('routes with the file owner and the platform-specific escape modifier', () => {
  const isMac = navigator.userAgent.includes('Mac')
  openCsvHttpLink(
    'https://example.com/',
    { metaKey: isMac, ctrlKey: !isMac, shiftKey: true },
    { filePath: '/demo.csv', worktreeId: 'folder:demo' }
  )
  expect(openHttpLink).toHaveBeenCalledWith('https://example.com/', {
    worktreeId: 'folder:demo',
    sourceOwner: { kind: 'local' },
    modifierHeld: true
  })
})

it('uses the pinned SSH and runtime owners without consulting the active workspace', () => {
  const event = { metaKey: false, ctrlKey: false, shiftKey: false }
  openCsvHttpLink('http://localhost:3000/', event, {
    filePath: '/demo.csv',
    worktreeId: 'folder:ssh',
    connectionId: 'ssh-owner'
  })
  expect(openHttpLink).toHaveBeenLastCalledWith('http://localhost:3000/', {
    worktreeId: 'folder:ssh',
    sourceOwner: { kind: 'ssh', connectionId: 'ssh-owner' }
  })
  openCsvHttpLink('https://example.com/', event, {
    filePath: '/demo.csv',
    worktreeId: 'folder:paired',
    runtimeEnvironmentId: 'paired-owner'
  })
  expect(openHttpLink).toHaveBeenLastCalledWith('https://example.com/', {
    worktreeId: 'folder:paired',
    sourceOwner: { kind: 'runtime', runtimeEnvironmentId: 'paired-owner' }
  })
  expect(getConnectionIdForFile).not.toHaveBeenCalled()
})

it('leaves unresolved ownership to the existing routing guard', () => {
  getConnectionIdForFile.mockReturnValueOnce(undefined)
  openCsvHttpLink(
    'https://example.com/',
    { metaKey: false, ctrlKey: false, shiftKey: false },
    {
      filePath: '/demo.csv',
      worktreeId: 'missing-workspace'
    }
  )
  expect(openHttpLink).toHaveBeenCalledWith('https://example.com/', {
    worktreeId: 'missing-workspace',
    sourceOwner: { kind: 'unknown' }
  })
})
