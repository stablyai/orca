// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { PreservedBranchCleanup } from '@/lib/preserved-branch-cleanup'
import PreservedBranchBatchReviewModal from './PreservedBranchBatchReviewModal'
import {
  forceDeletePreservedBranchBatch,
  showPreservedBranchBatchToast
} from './preserved-branch-batch-toast'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => {
  const state = {
    activeModal: 'none',
    modalData: {} as Record<string, unknown>,
    repos: [],
    closeModal: vi.fn(),
    openModal: vi.fn(),
    forceDeletePreservedBranch: vi.fn()
  }
  return { state }
})

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
  return { useAppStore }
})

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    loading: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

const mountedRoots: Root[] = []

function renderToastBody(): HTMLElement {
  const description = vi.mocked(toast.warning).mock.calls.at(-1)?.[1]
    ?.description as React.ReactElement
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  act(() => root.render(description))
  return container
}

function renderReviewModal(branches: readonly PreservedBranchCleanup[]): void {
  mocks.state.activeModal = 'preserved-branch-review'
  mocks.state.modalData = { branches }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  act(() => root.render(<PreservedBranchBatchReviewModal />))
}

async function clickButton(container: HTMLElement, label: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find(
    (element) => element.textContent?.trim() === label
  )
  if (!button) {
    throw new Error(`button "${label}" not found`)
  }
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
}

async function clickCheckbox(id: string): Promise<void> {
  const checkbox = document.getElementById(id)
  if (!checkbox) {
    throw new Error(`checkbox "${id}" not found`)
  }
  await act(async () => {
    checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
}

beforeEach(() => {
  mocks.state.activeModal = 'none'
  mocks.state.modalData = {}
  mocks.state.closeModal.mockReset()
  mocks.state.openModal.mockReset()
  mocks.state.forceDeletePreservedBranch.mockReset().mockResolvedValue({ ok: true, deleted: true })
})

afterEach(() => {
  mountedRoots.splice(0).forEach((root) => act(() => root.unmount()))
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('showPreservedBranchBatchToast', () => {
  it('explains disk cleanup and opens one review dialog for the batch', async () => {
    const branches = [
      { worktreeId: 'repo-a::one', branchName: 'feature/one', expectedHead: 'head-one' },
      { worktreeId: 'repo-b::two', branchName: 'feature/two', expectedHead: 'head-two' }
    ]
    showPreservedBranchBatchToast(12, branches)
    const body = renderToastBody()

    expect(toast.warning).toHaveBeenCalledWith(
      '12 workspaces removed, 2 branches kept',
      expect.objectContaining({ dismissible: true, duration: Infinity })
    )
    expect(body.textContent).toContain('Kept branches do not retain workspace folders')
    expect(body.textContent).toContain('Orca may continue freeing workspace disk space')

    await clickButton(body, 'Review 2 Branches')

    expect(mocks.state.openModal).toHaveBeenCalledWith('preserved-branch-review', { branches })
    expect(toast.dismiss).toHaveBeenCalledWith('preserved-branch-batch:repo-a::one:2')
    expect(mocks.state.forceDeletePreservedBranch).not.toHaveBeenCalled()
  })

  it('force-deletes only the branches selected in review', async () => {
    renderReviewModal([
      { worktreeId: 'repo-a::one', branchName: 'feature/one', expectedHead: 'head-one' },
      { worktreeId: 'repo-b::two', branchName: 'feature/two', expectedHead: 'head-two' }
    ])

    expect(document.body.textContent).toContain('Review kept branches')
    expect(document.body.textContent).toContain('2 of 2 selected')
    await clickCheckbox('preserved-branch-1')
    expect(document.body.textContent).toContain('1 of 2 selected')
    expect(
      document.getElementById('preserved-branch-select-all')?.querySelector('.lucide-minus')
    ).not.toBeNull()
    await clickButton(document.body, 'Force Delete 1 Branch')

    expect(mocks.state.closeModal).toHaveBeenCalledOnce()
    expect(mocks.state.forceDeletePreservedBranch).toHaveBeenCalledOnce()
    expect(mocks.state.forceDeletePreservedBranch).toHaveBeenCalledWith(
      'repo-a::one',
      'feature/one',
      'head-one',
      { suppressToast: true }
    )
    expect(toast.success).toHaveBeenCalledWith('Local branches deleted: 1', {
      id: 'force-delete-branch-batch:repo-a::one:1'
    })
  })

  it('keeps older-server branches visible without offering an unsafe delete', () => {
    showPreservedBranchBatchToast(3, [{ worktreeId: 'repo-a::one', branchName: 'feature/one' }])
    const body = renderToastBody()

    expect(body.querySelector('button')).toBeNull()
    expect(toast.warning).toHaveBeenCalledWith(
      '3 workspaces removed, 1 branch kept',
      expect.not.objectContaining({ duration: Infinity })
    )
  })

  it('serializes branch deletion within one repository', async () => {
    let resolveFirst: (result: { ok: true; deleted: true }) => void = () => {}
    mocks.state.forceDeletePreservedBranch
      .mockReset()
      .mockReturnValueOnce(
        new Promise<{ ok: true; deleted: true }>((resolve) => {
          resolveFirst = resolve
        })
      )
      .mockResolvedValueOnce({ ok: true, deleted: true })
    const deletion = forceDeletePreservedBranchBatch([
      { worktreeId: 'repo-a::one', branchName: 'feature/one', expectedHead: 'head-one' },
      { worktreeId: 'repo-a::two', branchName: 'feature/two', expectedHead: 'head-two' }
    ])

    expect(mocks.state.forceDeletePreservedBranch).toHaveBeenCalledTimes(1)
    resolveFirst({ ok: true, deleted: true })
    await deletion
    expect(mocks.state.forceDeletePreservedBranch).toHaveBeenCalledTimes(2)
  })

  it('shows an unavailable branch without blocking review of actionable branches', async () => {
    renderReviewModal([
      { worktreeId: 'repo-a::one', branchName: 'feature/one', expectedHead: 'head-one' },
      { worktreeId: 'repo-b::two', branchName: 'feature/two' }
    ])

    expect(document.body.textContent).toContain('Head unavailable')
    expect((document.getElementById('preserved-branch-1') as HTMLButtonElement).disabled).toBe(true)
    await clickButton(document.body, 'Force Delete 1 Branch')

    expect(mocks.state.forceDeletePreservedBranch).toHaveBeenCalledOnce()
    expect(mocks.state.forceDeletePreservedBranch).toHaveBeenCalledWith(
      'repo-a::one',
      'feature/one',
      'head-one',
      { suppressToast: true }
    )
  })
})
