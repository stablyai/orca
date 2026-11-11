// @vitest-environment happy-dom
import { hostMocks, mocks } from './launch-work-item-direct-test-fixture'
import { readDirectSetupRequest } from '@/lib/workspace/creation/work-item/direct-work-item-setup-test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { useAppStore } from '@/store/index'
import { createUIStore } from '@/store/slices/ui/ui-slice-test-harness'

vi.doUnmock('@/runtime/repo-hooks/ensure-hooks-confirmed')
const { launchWorkItemDirect } = await import('./launch-work-item-direct')
const { __resetTrustPromptChainForTests } =
  await import('../../../../runtime/repo-hooks/ensure-hooks-confirmed')
const { DirectWorkItemSetupDialog } =
  await import('@/components/new-workspace/DirectWorkItemSetupDialog')

const hooks = { scripts: { setup: 'echo prepared' } }
const args = {
  repoId: 'repo-1',
  launchSource: 'task_page' as const,
  openModalFallback: vi.fn(),
  item: {
    type: 'issue' as const,
    number: 42,
    title: 'Fix checks',
    url: 'https://github.com/acme/repo/issues/42'
  }
}

describe('direct work item setup preparation', () => {
  let unsubscribe: () => void
  beforeEach(() => {
    __resetTrustPromptChainForTests()
    args.openModalFallback.mockClear()
    const ui = createUIStore()
    useAppStore.setState({
      openModal: ui.getState().openModal,
      closeModal: ui.getState().closeModal,
      modalData: {}
    })
    unsubscribe = ui.subscribe(({ activeModal, modalData }) =>
      useAppStore.setState({ activeModal, modalData })
    )
    useAppStore.setState({
      trustedOrcaHooks: { 'repo-1': { all: { approvedAt: 1 } } },
      repos: [
        {
          ...useAppStore.getState().repos[0],
          hookSettings: {
            mode: 'auto',
            scripts: { setup: '', archive: '' },
            setupRunPolicy: 'ask'
          }
        }
      ]
    })
  })
  afterEach(() => {
    cleanup()
    useAppStore.getState().closeModal()
    unsubscribe()
  })

  async function chooseSetup(): Promise<void> {
    await vi.waitFor(() =>
      expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
    )
    readDirectSetupRequest(useAppStore.getState().modalData.directSetup).choose('run')
  }

  it('aborts the actual trust prompt, releases its queue, and permits a fresh launch', async () => {
    useAppStore.setState({ trustedOrcaHooks: {} })
    hostMocks.checkRuntimeHooks.mockResolvedValue({ hasHooks: true, hooks })
    const abort = new AbortController()
    const launch = launchWorkItemDirect({ ...args, signal: abort.signal })
    await chooseSetup()
    await vi.waitFor(() =>
      expect(useAppStore.getState().activeModal).toBe('confirm-orca-yaml-hooks')
    )
    const lateResolve = useAppStore.getState().modalData.onResolve
    abort.abort()
    await expect(launch).resolves.toBe('cancelled')
    expect(useAppStore.getState().activeModal).toBe('none')
    expect(mocks.createWorktree).not.toHaveBeenCalled()
    const fresh = launchWorkItemDirect(args)
    await chooseSetup()
    await vi.waitFor(() =>
      expect(useAppStore.getState().activeModal).toBe('confirm-orca-yaml-hooks')
    )
    const successor = useAppStore.getState().modalData
    if (typeof lateResolve !== 'function') {
      throw new Error('Expected the actual trust callback')
    }
    lateResolve('run')
    expect(useAppStore.getState().modalData).toBe(successor)
    if (typeof successor.onResolve !== 'function') {
      throw new Error('Expected fresh trust callback')
    }
    successor.onResolve('run')
    useAppStore.getState().closeModal()
    await expect(fresh).resolves.toBe(true)
    expect(mocks.createWorktree).toHaveBeenCalledOnce()
  })

  it('keeps a replacement modal when the evicted actual trust attempt later aborts', async () => {
    useAppStore.setState({ trustedOrcaHooks: {} })
    hostMocks.checkRuntimeHooks.mockResolvedValue({ hasHooks: true, hooks })
    const abort = new AbortController()
    const launch = launchWorkItemDirect({ ...args, signal: abort.signal })
    await chooseSetup()
    await vi.waitFor(() =>
      expect(useAppStore.getState().activeModal).toBe('confirm-orca-yaml-hooks')
    )
    useAppStore.getState().openModal('quick-open', { successor: true })
    abort.abort()
    await expect(launch).resolves.toBe('cancelled')
    expect(useAppStore.getState().modalData).toEqual({ successor: true })
    expect(mocks.createWorktree).not.toHaveBeenCalled()
  })

  it('cancels unknown recovery after a real Retry wake, ignoring its late read', async () => {
    const read = Promise.withResolvers<{ hasHooks: boolean; hooks: typeof hooks }>()
    hostMocks.checkRuntimeHooks
      .mockRejectedValueOnce(new Error('unknown'))
      .mockReturnValueOnce(read.promise)
    const abort = new AbortController()
    const launch = launchWorkItemDirect({ ...args, signal: abort.signal })
    await vi.waitFor(() =>
      expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
    )
    render(
      <DirectWorkItemSetupDialog
        request={readDirectSetupRequest(useAppStore.getState().modalData.directSetup)}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    abort.abort()
    await expect(launch).resolves.toBe('cancelled')
    useAppStore.getState().openModal('quick-open', { successor: true })
    await act(async () => read.resolve({ hasHooks: true, hooks }))
    expect(useAppStore.getState().modalData).toEqual({ successor: true })
    expect(mocks.createWorktree).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})
