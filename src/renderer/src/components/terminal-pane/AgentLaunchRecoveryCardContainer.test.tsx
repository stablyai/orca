// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentLaunchRecoveryCardContainer } from './AgentLaunchRecoveryCardContainer'
import type {
  AgentLaunchFailureCode,
  PersistedAgentLaunchFailure
} from '../../../../shared/agent-launch-contract'

const WORKTREE_ID = 'repo1::/tmp/wt'

type WorktreeShape = {
  agentLaunchFailure?: PersistedAgentLaunchFailure
  pendingAgentLaunch?: { operationId: string; requestedAgent: never; priorFailureId?: string }
}

const storeBox = vi.hoisted(() => ({ state: null as unknown }))
const worktreeBox = vi.hoisted(() => ({ worktree: null as WorktreeShape | null }))
// Holds what the soft confirm hook returns; a null value reproduces a
// provider-less render (the crash class that took out the WorktreeCard family).
const confirmBox = vi.hoisted(() => ({ value: null as unknown }))

const mocks = vi.hoisted(() => ({
  retryWorktreeAgentLaunch: vi.fn(),
  forgetWorktreeAgentLaunch: vi.fn(),
  unknownAgentLaunchSiblingPreflight: vi.fn(),
  forgetUnknownAgentLaunchSiblings: vi.fn(),
  openSettingsTarget: vi.fn(),
  confirm: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(storeBox.state), {
    getState: () => storeBox.state
  })
}))

vi.mock('@/components/confirmation-dialog-context', () => ({
  useOptionalConfirmationDialog: () => confirmBox.value
}))

vi.mock('@/store/selectors', () => ({
  getWorktreeMapFromState: () =>
    new Map(worktreeBox.worktree ? [[WORKTREE_ID, worktreeBox.worktree]] : [])
}))

function failure(code: AgentLaunchFailureCode): PersistedAgentLaunchFailure {
  return { code, version: 1, failureId: 'failure-7', intent: 'interactive', occurredAt: 0 }
}

const mountedRoots: Root[] = []

async function render(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(<AgentLaunchRecoveryCardContainer worktreeId={WORKTREE_ID} />)
  })
}

function buttonByLabel(label: string): HTMLButtonElement {
  const match = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => (button.textContent ?? '') === label
  )
  if (!match) {
    throw new Error(`No button labelled "${label}"`)
  }
  return match
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset()
  }
  mocks.retryWorktreeAgentLaunch.mockResolvedValue({ status: 'launched', receipt: {} })
  mocks.forgetWorktreeAgentLaunch.mockResolvedValue({ status: 'forgotten' })
  mocks.unknownAgentLaunchSiblingPreflight.mockResolvedValue({ count: 0, hostName: '' })
  mocks.forgetUnknownAgentLaunchSiblings.mockResolvedValue({ forgottenCount: 0 })
  mocks.confirm.mockResolvedValue(true)
  confirmBox.value = mocks.confirm
  worktreeBox.worktree = null
  storeBox.state = {
    retryWorktreeAgentLaunch: mocks.retryWorktreeAgentLaunch,
    forgetWorktreeAgentLaunch: mocks.forgetWorktreeAgentLaunch,
    unknownAgentLaunchSiblingPreflight: mocks.unknownAgentLaunchSiblingPreflight,
    forgetUnknownAgentLaunchSiblings: mocks.forgetUnknownAgentLaunchSiblings,
    openSettingsTarget: mocks.openSettingsTarget
  }
})

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount())
  }
  document.body.innerHTML = ''
})

describe('AgentLaunchRecoveryCardContainer', () => {
  it('renders nothing when the workspace has no durable failure', async () => {
    await render()
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
  })

  it('retries the pinned identity against the current failure id', async () => {
    worktreeBox.worktree = { agentLaunchFailure: failure('spawn_failed') }
    await render()
    await act(async () => {
      buttonByLabel('Retry').click()
    })
    expect(mocks.retryWorktreeAgentLaunch).toHaveBeenCalledExactlyOnceWith({
      worktreeId: WORKTREE_ID,
      expectedFailureId: 'failure-7',
      action: { kind: 'retry-same' }
    })
  })

  it('forgets an unknown launch after the destructive confirmation, using the pending operation id as the guard', async () => {
    worktreeBox.worktree = {
      agentLaunchFailure: failure('launch_state_unknown'),
      pendingAgentLaunch: { operationId: 'op-3', requestedAgent: undefined as never }
    }
    await render()
    await act(async () => {
      buttonByLabel('Forget launch…').click()
    })
    expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        confirmVariant: 'destructive',
        description:
          'Orca cannot reach the terminal host. Forgetting does not stop the remote process; it may still be running.'
      })
    )
    expect(mocks.forgetWorktreeAgentLaunch).toHaveBeenCalledExactlyOnceWith({
      worktreeId: WORKTREE_ID,
      expectedOperationId: 'op-3'
    })
  })

  it('does not forget when the destructive confirmation is declined', async () => {
    mocks.confirm.mockResolvedValue(false)
    worktreeBox.worktree = {
      agentLaunchFailure: failure('launch_state_unknown'),
      pendingAgentLaunch: { operationId: 'op-3', requestedAgent: undefined as never }
    }
    await render()
    await act(async () => {
      buttonByLabel('Forget launch…').click()
    })
    expect(mocks.confirm).toHaveBeenCalledOnce()
    expect(mocks.forgetWorktreeAgentLaunch).not.toHaveBeenCalled()
  })

  it('disables Forget (and never confirms or forgets) when no pending operation id survives reconciliation', async () => {
    worktreeBox.worktree = { agentLaunchFailure: failure('launch_state_unknown') }
    await render()
    expect(buttonByLabel('Forget launch…').disabled).toBe(true)
    await act(async () => {
      buttonByLabel('Forget launch…').click()
    })
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.forgetWorktreeAgentLaunch).not.toHaveBeenCalled()
  })

  it('offers the sibling opt-in and bulk-forgets when the box is checked', async () => {
    mocks.unknownAgentLaunchSiblingPreflight.mockResolvedValue({ count: 3, hostName: 'devbox' })
    mocks.confirm.mockImplementation(
      async (options: { optIn?: { onConfirm: (checked: boolean) => void } }) => {
        options.optIn?.onConfirm(true)
        return true
      }
    )
    worktreeBox.worktree = {
      agentLaunchFailure: failure('launch_state_unknown'),
      pendingAgentLaunch: { operationId: 'op-3', requestedAgent: undefined as never }
    }
    await render()
    await act(async () => {
      buttonByLabel('Forget launch…').click()
    })
    expect(mocks.unknownAgentLaunchSiblingPreflight).toHaveBeenCalledExactlyOnceWith({
      worktreeId: WORKTREE_ID
    })
    expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        optIn: expect.objectContaining({
          label: 'Also forget 3 other stranded launches on devbox.'
        })
      })
    )
    expect(mocks.forgetWorktreeAgentLaunch).toHaveBeenCalledExactlyOnceWith({
      worktreeId: WORKTREE_ID,
      expectedOperationId: 'op-3'
    })
    expect(mocks.forgetUnknownAgentLaunchSiblings).toHaveBeenCalledExactlyOnceWith({
      worktreeId: WORKTREE_ID
    })
  })

  it('offers the opt-in but skips the bulk forget when the box is left unchecked', async () => {
    mocks.unknownAgentLaunchSiblingPreflight.mockResolvedValue({ count: 1, hostName: 'devbox' })
    mocks.confirm.mockImplementation(
      async (options: { optIn?: { onConfirm: (checked: boolean) => void } }) => {
        options.optIn?.onConfirm(false)
        return true
      }
    )
    worktreeBox.worktree = {
      agentLaunchFailure: failure('launch_state_unknown'),
      pendingAgentLaunch: { operationId: 'op-3', requestedAgent: undefined as never }
    }
    await render()
    await act(async () => {
      buttonByLabel('Forget launch…').click()
    })
    expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        optIn: expect.objectContaining({
          label: 'Also forget 1 other stranded launch on devbox.'
        })
      })
    )
    expect(mocks.forgetWorktreeAgentLaunch).toHaveBeenCalledOnce()
    expect(mocks.forgetUnknownAgentLaunchSiblings).not.toHaveBeenCalled()
  })

  it('omits the opt-in and still forgets when the sibling preflight fails', async () => {
    mocks.unknownAgentLaunchSiblingPreflight.mockRejectedValue(new Error('unreachable'))
    worktreeBox.worktree = {
      agentLaunchFailure: failure('launch_state_unknown'),
      pendingAgentLaunch: { operationId: 'op-3', requestedAgent: undefined as never }
    }
    await render()
    await act(async () => {
      buttonByLabel('Forget launch…').click()
    })
    expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(
      expect.not.objectContaining({ optIn: expect.anything() })
    )
    expect(mocks.forgetWorktreeAgentLaunch).toHaveBeenCalledOnce()
    expect(mocks.forgetUnknownAgentLaunchSiblings).not.toHaveBeenCalled()
  })

  it('renders the recovery card and no-ops forget when no confirmation provider is mounted', async () => {
    // Defensive parity with the WorktreeCard family fix: rendered without the
    // provider the soft hook returns null; the card must render and the
    // destructive forget must not fire unconfirmed rather than throwing.
    confirmBox.value = null
    worktreeBox.worktree = {
      agentLaunchFailure: failure('launch_state_unknown'),
      pendingAgentLaunch: { operationId: 'op-3', requestedAgent: undefined as never }
    }
    await render()
    expect(document.body.querySelector('[role="alert"]')).not.toBeNull()
    await act(async () => {
      buttonByLabel('Forget launch…').click()
    })
    expect(mocks.forgetWorktreeAgentLaunch).not.toHaveBeenCalled()
    expect(mocks.unknownAgentLaunchSiblingPreflight).not.toHaveBeenCalled()
  })

  it('routes selection recovery to the desktop-host agents settings pane', async () => {
    worktreeBox.worktree = { agentLaunchFailure: failure('unknown_agent') }
    await render()
    await act(async () => {
      buttonByLabel('Choose agent').click()
    })
    expect(mocks.openSettingsTarget).toHaveBeenCalledExactlyOnceWith({
      pane: 'agents',
      repoId: null
    })
    expect(mocks.retryWorktreeAgentLaunch).not.toHaveBeenCalled()
  })
})
