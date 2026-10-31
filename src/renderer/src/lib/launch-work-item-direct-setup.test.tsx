// @vitest-environment happy-dom
import { hostMocks, mocks } from './launch-work-item-direct-test-fixture'
import { readDirectSetupRequest } from '@/lib/direct-work-item-setup-test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as preflight from './launch-work-item-direct-preflight'
import * as inventory from './agent-detection-target-inventory'
import * as draft from './launch-work-item-direct-draft'
import * as preparation from './launch-work-item-direct-route-preparation'
import * as delivery from './agent-launch-prompt-delivery'
import { resolveDirectSetupDecision } from './launch-work-item-direct-preflight'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

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

  it.each([
    { status: 'error', hasHooks: false, hooks: null },
    { hasHooks: true, hooks: null }
  ])('does not turn an unknown inspection into inherited consent: %j', async (reply) => {
    hostMocks.checkRuntimeHooks.mockResolvedValue(reply)
    await expect(
      resolveDirectSetupDecision(
        'repo-1',
        {
          hookSettings: {
            commandSourcePolicy: 'run-both',
            scripts: { setup: 'echo local', archive: '' },
            mode: 'auto'
          }
        },
        LOCAL_EXECUTION_HOST_ID
      )
    ).resolves.toMatchObject({ kind: 'unavailable' })
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

  it.each(['run', 'skip'] as const)(
    'recovers a YAML-only Ask inspection before accepting %s on the original request',
    async (choice) => {
      hostMocks.checkRuntimeHooks
        .mockRejectedValueOnce(new Error('timed out'))
        .mockResolvedValueOnce({ status: 'error', hasHooks: false, hooks: null })
        .mockResolvedValue({ hasHooks: true, hooks, mayNeedUpdate: false })
      const sink = Promise.withResolvers<boolean>()
      mocks.pasteDraftWhenAgentReady.mockReturnValueOnce(sink.promise)
      const dispatched = vi.spyOn(delivery, 'deliverLaunchPromptToAgentTab')
      const launch = launchWorkItemDirect({
        ...args,
        agentOverride: 'codex',
        agentArgs: '--model o3',
        promptDelivery: 'submit-after-ready',
        item: { ...args.item, pasteContent: 'My edited fix prompt' }
      })
      await vi.waitFor(() =>
        expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
      )
      const pending = readDirectSetupRequest(useAppStore.getState().modalData.directSetup)
      expect(pending.inspection.kind).toBe('unavailable')
      expect(mocks.createWorktree).not.toHaveBeenCalled()
      expect(mocks.pasteDraftWhenAgentReady).not.toHaveBeenCalled()
      render(<DirectWorkItemSetupDialog request={pending} />)
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await vi.waitFor(() =>
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Retry' }).disabled).toBe(
          false
        )
      )
      expect(hostMocks.checkRuntimeHooks).toHaveBeenCalledTimes(2)
      expect(mocks.createWorktree).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await screen.findByText('echo prepared')
      expect(mocks.createWorktree).not.toHaveBeenCalled()
      fireEvent.click(
        screen.getByRole('button', {
          name: choice === 'run' ? 'Run setup' : 'Skip setup',
          exact: true
        })
      )
      pending.choose(choice)
      await expect(launch).resolves.toBe(true)
      expect(mocks.createWorktree).toHaveBeenCalledOnce()
      expect(mocks.createWorktree.mock.calls[0][3]).toBe(choice)
      expect(mocks.pasteDraftWhenAgentReady).toHaveBeenCalledOnce()
      expect(mocks.pasteDraftWhenAgentReady).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'My edited fix prompt', agent: 'codex', submit: true })
      )
      expect(dispatched).toHaveBeenCalledOnce()
      const dispatchResult = dispatched.mock.results[0]
      if (dispatchResult.type !== 'return') {
        throw new Error('Expected actual dispatch promise')
      }
      sink.resolve(true)
      await expect(dispatchResult.value).resolves.toBe(true)
      expect(args.openModalFallback).not.toHaveBeenCalled()
      expect(mocks.toastError).not.toHaveBeenCalled()
    }
  )

  async function chooseSetup(): Promise<void> {
    await vi.waitFor(() =>
      expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
    )
    readDirectSetupRequest(useAppStore.getState().modalData.directSetup).choose('run')
  }

  it.each(['pr', 'project', 'detection', 'draft', 'plan', 'create', 'agent-preparation'] as const)(
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
        case 'create':
          mocks.createWorktree.mockReturnValueOnce(gate.promise)
          reached = () => mocks.createWorktree.mock.calls.length > 0
          break
        case 'agent-preparation': {
          const prepare = vi
            .spyOn(preparation, 'prepareDirectWorkItemAgentLaunch')
            .mockReturnValueOnce(gate.promise)
          reached = () => prepare.mock.calls.length > 0
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
      expect(mocks.createWorktree).toHaveBeenCalledTimes(
        ['create', 'agent-preparation'].includes(stage) ? 1 : 0
      )
    }
  )

  it.each(['unavailable-agent', 'invalid-args'] as const)(
    'suppresses cancelled %s failure results after delayed preparation',
    async (shape) => {
      const abort = new AbortController()
      hostMocks.checkRuntimeHooks.mockResolvedValue({ hasHooks: true, hooks })
      if (shape === 'unavailable-agent') {
        const gate =
          Promise.withResolvers<
            Awaited<ReturnType<typeof preflight.resolveDirectProspectiveAgent>>
          >()
        const detect = vi
          .spyOn(preflight, 'resolveDirectProspectiveAgent')
          .mockReturnValueOnce(gate.promise)
        const launch = launchWorkItemDirect({ ...args, signal: abort.signal })
        await chooseSetup()
        await vi.waitFor(() => expect(detect).toHaveBeenCalled())
        abort.abort()
        gate.resolve({ prospectiveAgent: null, unavailable: true })
        await expect(launch).resolves.toBe('cancelled')
      } else {
        const gate =
          Promise.withResolvers<Awaited<ReturnType<typeof preflight.planDirectWorkItemLaunch>>>()
        const plan = vi
          .spyOn(preflight, 'planDirectWorkItemLaunch')
          .mockReturnValueOnce(gate.promise)
        const launch = launchWorkItemDirect({
          ...args,
          signal: abort.signal,
          agentArgs: '"unterminated'
        })
        await chooseSetup()
        await vi.waitFor(() => expect(plan).toHaveBeenCalled())
        abort.abort()
        gate.resolve(undefined)
        await expect(launch).resolves.toBe('cancelled')
      }
      expect(mocks.toastError).not.toHaveBeenCalled()
      expect(args.openModalFallback).not.toHaveBeenCalled()
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

  it.each([
    { policy: 'run-by-default', command: 'echo local', decision: 'run' },
    { policy: 'skip-by-default', command: 'echo local', decision: 'skip' },
    { policy: 'ask', command: 'echo local', decision: 'run' },
    { policy: 'ask', command: '', decision: 'inherit' }
  ] as const)(
    'finishes known local-only setup with unusable YAML: %j',
    async ({ policy, command, decision }) => {
      useAppStore.setState({
        repos: [
          {
            ...useAppStore.getState().repos[0],
            hookSettings: {
              commandSourcePolicy: 'local-only',
              setupRunPolicy: policy,
              scripts: { setup: command, archive: '' },
              mode: 'auto'
            }
          }
        ]
      })
      hostMocks.checkRuntimeHooks.mockRejectedValue(new Error('unrelated YAML failure'))
      const launch = launchWorkItemDirect(args)
      if (policy === 'ask' && command) {
        await chooseSetup()
      }
      await expect(launch).resolves.toBe(true)
      expect(hostMocks.checkRuntimeHooks).not.toHaveBeenCalled()
      expect(mocks.createWorktree.mock.calls[0][3]).toBe(decision)
      expect(mocks.toastError).not.toHaveBeenCalled()
    }
  )

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
