// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import QuickOpen from './QuickOpen'
import { TooltipProvider } from './ui/tooltip'

const mocks = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(), skip: vi.fn() }))
const state = {
  activeModal: 'quick-open',
  activeWorktreeId: 'workspace',
  closeModal: mocks.close
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
vi.mock('@/store/workspaces/selection/use-selected-worktree', () => ({
  useActiveWorktree: () => ({ path: '/workspace' })
}))
vi.mock('@/store/workspaces/selection/known-worktree-selection', () => ({
  selectFileListWorktree: () => ({ path: '/workspace' })
}))
vi.mock('./quick-open-file-list', () => ({
  useRuntimeFileListForWorktree: () => ({ files, loading: false, loadError: null })
}))
vi.mock('./right-sidebar/file-explorer/navigation/file-explorer-operation-owner', () => ({
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
