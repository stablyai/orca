import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostMocks, mocks } from './launch-work-item-direct-test-fixture'
import { launchWorkItemDirect } from './launch-work-item-direct'
import { resolveDirectSetupDecision } from './launch-work-item-direct-preflight'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

import { useAppStore } from '@/store'
import { createUIStore } from '@/store/slices/ui-slice-test-harness'
import type { DirectWorkItemSetupRequest } from './direct-work-item-setup'

vi.unmock('@/lib/ensure-hooks-confirmed')

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
    useAppStore.getState().closeModal()
    unsubscribe()
  })

  it.each([
    { status: 'error', hasHooks: false, hooks: null },
    { hasHooks: true, hooks: null }
  ])('does not turn an unknown inspection into inherited consent: %j', async (reply) => {
    hostMocks.checkRuntimeHooks.mockResolvedValue(reply)
    await expect(
      resolveDirectSetupDecision('repo-1', {}, LOCAL_EXECUTION_HOST_ID)
    ).resolves.toMatchObject({ kind: 'unavailable' })
  })

  it('does not treat a timed out YAML inspection as confirmed absence', async () => {
    hostMocks.checkRuntimeHooks.mockRejectedValue(new Error('timed out'))
    await expect(
      resolveDirectSetupDecision('repo-1', {}, LOCAL_EXECUTION_HOST_ID)
    ).resolves.toMatchObject({ kind: 'unavailable' })
    expect(mocks.createWorktree).not.toHaveBeenCalled()
  })

  it('does not create after the originating attempt was cancelled during inspection', async () => {
    const abort = new AbortController()
    let finish: (value: { hasHooks: boolean; hooks: null }) => void = () => undefined
    hostMocks.checkRuntimeHooks.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const launch = launchWorkItemDirect({ ...args, signal: abort.signal })
    abort.abort()
    finish({ hasHooks: false, hooks: null })
    await expect(launch).resolves.toBe('cancelled')
    expect(mocks.createWorktree).not.toHaveBeenCalled()
  })

  it.each(['run', 'skip'] as const)(
    'recovers a YAML-only Ask inspection before accepting %s on the original request',
    async (choice) => {
      hostMocks.checkRuntimeHooks
        .mockRejectedValueOnce(new Error('timed out'))
        .mockResolvedValue({ hasHooks: true, hooks, mayNeedUpdate: false })
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
      // SAFETY: the real launcher installed this typed preparation request in the modal slot.
      const pending = useAppStore.getState().modalData.directSetup as DirectWorkItemSetupRequest
      expect(pending.inspection.kind).toBe('unavailable')
      expect(mocks.createWorktree).not.toHaveBeenCalled()
      expect(mocks.pasteDraftWhenAgentReady).not.toHaveBeenCalled()
      expect(await pending.inspect()).toMatchObject({
        kind: 'needs-modal',
        setupConfig: { command: 'echo prepared', source: 'yaml' }
      })
      expect(mocks.createWorktree).not.toHaveBeenCalled()
      pending.choose(choice)
      pending.choose(choice)
      await expect(launch).resolves.toBe(true)
      expect(mocks.createWorktree).toHaveBeenCalledOnce()
      expect(mocks.createWorktree.mock.calls[0][3]).toBe(choice)
      expect(mocks.pasteDraftWhenAgentReady).toHaveBeenCalledOnce()
      expect(mocks.pasteDraftWhenAgentReady).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'My edited fix prompt', agent: 'codex', submit: true })
      )
      expect(args.openModalFallback).not.toHaveBeenCalled()
      expect(mocks.toastError).not.toHaveBeenCalled()
    }
  )
})
