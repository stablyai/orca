// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import QuickOpen from './QuickOpen'
import { TooltipProvider } from './ui/tooltip'

const mocks = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(), skip: vi.fn() }))
const state = {
  activeModal: 'quick-open',
  activeWorktreeId: 'workspace',
  closeModal: mocks.close,
  getKnownWorktreeById: () => ({ path: '/workspace' })
}
const history: readonly string[] = []
const files = [
  'apps/api/.env',
  'apps/web/.env',
  'src/product_detail.ts',
  'user/UserProfile/index.tsx'
]
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state,
    subscribe: () => () => {}
  })
}))
vi.mock('@/store/selectors', () => ({ useActiveWorktree: () => ({ path: '/workspace' }) }))
vi.mock('./quick-open-file-list', () => ({
  useRuntimeFileListForWorktree: () => ({ files, loading: false, loadError: null })
}))
vi.mock('./right-sidebar/file-explorer-operation-owner', () => ({
  getFileExplorerOperationOwnerFromState: () => ({ kind: 'local' })
}))
vi.mock('./quick-open-file-navigation', () => ({ openQuickOpenFile: mocks.open }))
vi.mock('@/lib/quick-open-file-history', () => ({
  useQuickOpenHistory: () => history
}))
vi.mock('@/hooks/useModalReturnFocus', () => ({
  useModalReturnFocus: () => ({ captureReturnFocus: () => {}, skipReturnFocus: mocks.skip })
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

beforeEach(() => {
  state.activeModal = 'quick-open'
  state.activeWorktreeId = 'workspace'
  vi.clearAllMocks()
  mocks.open.mockResolvedValue(undefined)
  HTMLElement.prototype.scrollIntoView = vi.fn()
})
afterEach(cleanup)

it('selects a new sole result after typing and opens its suffix location with Enter', async () => {
  render(
    <TooltipProvider>
      <QuickOpen />
    </TooltipProvider>
  )
  const input = screen.getByRole('combobox')
  fireEvent.change(input, { target: { value: '.env api' } })
  await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1))
  expect(screen.getByRole('option').getAttribute('aria-selected')).toBe('true')
  fireEvent.change(input, { target: { value: 'product-detail:2:3' } })
  await waitFor(() => expect(screen.getByRole('option').textContent).toContain('product_detail.ts'))
  expect(screen.getByRole('option').getAttribute('aria-selected')).toBe('true')
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
  await waitFor(() => expect(mocks.open).toHaveBeenCalledOnce())
  expect(mocks.open).toHaveBeenCalledWith(
    'src/product_detail.ts',
    'workspace',
    '/workspace',
    { pathQuery: 'product-detail', line: 2, column: 3 },
    'product-detail:2:3',
    expect.any(Function)
  )
  expect(mocks.close).toHaveBeenCalledOnce()
})

it('retains the dialog on failure and recovers after changing the query', async () => {
  mocks.open.mockRejectedValueOnce(new Error('File no longer exists'))
  render(
    <TooltipProvider>
      <QuickOpen />
    </TooltipProvider>
  )
  const input = screen.getByRole('combobox')
  fireEvent.change(input, { target: { value: 'product-detail' } })
  await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1))
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('File no longer exists')
  )
  expect(mocks.close).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: '.env api' } })
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
  await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce())
})

it.each(['settings', 'workspace-change', 'query-change'])(
  'does not close or focus after %s replaces a pending selection',
  async (change) => {
    let settle: (() => void) | undefined
    mocks.open.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        })
    )
    const view = render(
      <TooltipProvider>
        <QuickOpen />
      </TooltipProvider>
    )
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'product-detail' } })
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1))
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    await waitFor(() => expect(mocks.open).toHaveBeenCalledOnce())
    const assertCurrent = mocks.open.mock.calls[0][5]
    if (change === 'settings') {
      state.activeModal = 'settings'
    } else if (change === 'workspace-change') {
      state.activeWorktreeId = 'another'
    } else {
      fireEvent.change(input, { target: { value: 'user-profile' } })
    }
    view.rerender(
      <TooltipProvider>
        <QuickOpen />
      </TooltipProvider>
    )
    expect(assertCurrent).toThrow('cancelled')
    settle?.()
    await waitFor(() => expect(mocks.skip).not.toHaveBeenCalled())
    expect(mocks.close).not.toHaveBeenCalled()
  }
)

it('renders the separator match beneath a same-named ancestor', async () => {
  render(
    <TooltipProvider>
      <QuickOpen />
    </TooltipProvider>
  )
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'user-profile' } })
  await waitFor(() => expect(screen.getByRole('option').textContent).toContain('index.tsx'))
})
