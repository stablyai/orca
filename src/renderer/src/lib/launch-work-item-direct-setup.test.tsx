// @vitest-environment happy-dom
import { hostMocks, mocks } from './launch-work-item-direct-test-fixture'
import { readDirectSetupRequest } from '@/lib/direct-work-item-setup-test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as preflight from './launch-work-item-direct-preflight'
import * as inventory from './agent-detection-target-inventory'
import * as draft from './launch-work-item-direct-draft'

import { useAppStore } from '@/store'
import { createUIStore } from '@/store/slices/ui-slice-test-harness'

vi.doUnmock('@/lib/ensure-hooks-confirmed')
const { launchWorkItemDirect } = await import('./launch-work-item-direct')
const { __resetTrustPromptChainForTests } = await import('./ensure-hooks-confirmed')
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

  it.each(['absent', 'error', 'malformed', 'rejection'] as const)(
    'cancels during initial inspection before consuming its late %s outcome',
    async (shape) => {
      const abort = new AbortController()
      const read = Promise.withResolvers<{ hasHooks: boolean; hooks: null; status?: 'error' }>()
      hostMocks.checkRuntimeHooks.mockReturnValueOnce(read.promise)
      const launch = launchWorkItemDirect({ ...args, signal: abort.signal })
      abort.abort()
      if (shape === 'rejection') {
        read.reject(new Error('late inspection failure'))
      } else {
        read.resolve({
          hasHooks: shape === 'malformed',
          hooks: null,
          ...(shape === 'error' ? { status: 'error' } : {})
        })
      }
      await expect(launch).resolves.toBe('cancelled')
      expect(mocks.createWorktree).not.toHaveBeenCalled()
      expect(mocks.toastError).not.toHaveBeenCalled()
      expect(args.openModalFallback).not.toHaveBeenCalled()
    }
  )

  async function chooseSetup(): Promise<void> {
    await vi.waitFor(() =>
      expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
    )
    readDirectSetupRequest(useAppStore.getState().modalData.directSetup).choose('run')
  }

  it.each(['pr', 'project', 'detection', 'draft', 'plan'] as const)(
    'suppresses a late cancelled %s rejection through the original launch',
    async (stage) => {
      const gate = Promise.withResolvers<never>()
      const abort = new AbortController()
      let reached: () => boolean
      switch (stage) {
        case 'pr':
          mocks.resolvePrBase.mockReturnValueOnce(gate.promise)
          reached = () => mocks.resolvePrBase.mock.calls.length > 0
          break
        case 'project': {
          const read = vi
            .spyOn(inventory, 'loadProjectLaunchContext')
            .mockReturnValueOnce(gate.promise)
          reached = () => read.mock.calls.length > 0
          break
        }
        case 'detection': {
          const detect = vi
            .spyOn(preflight, 'resolveDirectProspectiveAgent')
            .mockReturnValueOnce(gate.promise)
          reached = () => detect.mock.calls.length > 0
          break
        }
        case 'draft': {
          const read = vi
            .spyOn(draft, 'getDirectWorkItemDraftContent')
            .mockReturnValueOnce(gate.promise)
          reached = () => read.mock.calls.length > 0
          break
        }
        case 'plan': {
          const plan = vi
            .spyOn(preflight, 'planDirectWorkItemLaunch')
            .mockReturnValueOnce(gate.promise)
          reached = () => plan.mock.calls.length > 0
          break
        }
      }
      hostMocks.checkRuntimeHooks.mockResolvedValue({ hasHooks: true, hooks })
      const launch = launchWorkItemDirect({
        ...args,
        signal: abort.signal,
        item: { ...args.item, type: 'pr', url: 'https://github.com/acme/repo/pull/42' }
      })
      await chooseSetup()
      await vi.waitFor(() => expect(reached()).toBe(true))
      abort.abort()
      gate.reject(new Error('late preparation failed'))
      await expect(launch).resolves.toBe('cancelled')
      expect(mocks.toastError).not.toHaveBeenCalled()
      expect(args.openModalFallback).not.toHaveBeenCalled()
      expect(mocks.pasteDraftWhenAgentReady).not.toHaveBeenCalled()
      expect(mocks.createWorktree).not.toHaveBeenCalled()
    }
  )

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
