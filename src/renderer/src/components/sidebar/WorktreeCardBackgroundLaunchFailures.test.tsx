// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreeCardBackgroundLaunchFailures } from './WorktreeCardBackgroundLaunchFailures'
import type {
  AgentLaunchFailureCode,
  PersistedAgentLaunchFailure
} from '../../../../shared/agent-launch-contract'
import type { BackgroundAgentLaunchAttempt } from '../../../../shared/background-agent-launch'

const WORKTREE_ID = 'repo1::/tmp/wt'
const HOST_ID = 'ssh:devbox' as const

type WorktreeShape = { backgroundAgentLaunches?: BackgroundAgentLaunchAttempt[] }

const storeBox = vi.hoisted(() => ({ state: null as unknown }))
const worktreeBox = vi.hoisted(() => ({ byHost: new Map<string, WorktreeShape>() }))
// Holds what the soft confirm hook returns; a null value reproduces a
// provider-less render (the crash class that took out the WorktreeCard family).
const confirmBox = vi.hoisted(() => ({ value: null as unknown }))

const mocks = vi.hoisted(() => ({
  retryBackgroundAgentLaunch: vi.fn(),
  forgetBackgroundAgentLaunch: vi.fn(),
  unknownAgentLaunchSiblingPreflight: vi.fn(),
  forgetUnknownAgentLaunchSiblings: vi.fn(),
  openSettingsTarget: vi.fn(),
  openModal: vi.fn(),
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
  getWorktreeOnHostFromState: (_state: unknown, _worktreeId: string, hostId: string) =>
    worktreeBox.byHost.get(hostId)
}))

vi.mock('@/lib/worktree-operation-route', () => ({
  resolveWorktreeOperationRouteForHost: vi.fn(),
  settingsForWorktreeOperationRoute: vi.fn()
}))

function failure(code: AgentLaunchFailureCode): PersistedAgentLaunchFailure {
  return { code, version: 1, failureId: 'failure-7', intent: 'background', occurredAt: 0 }
}

function attempt(
  overrides: Partial<BackgroundAgentLaunchAttempt> = {}
): BackgroundAgentLaunchAttempt {
  return {
    attemptId: 'attempt-1',
    worktreeId: WORKTREE_ID,
    operationId: 'op-9',
    requestedAgent: undefined as never,
    baseAgent: null,
    state: 'failed',
    failure: failure('spawn_failed'),
    createdAt: 0,
    updatedAt: 0,
    forgottenAt: null,
    ...overrides
  }
}

const mountedRoots: Root[] = []

async function render(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(
      <WorktreeCardBackgroundLaunchFailures worktreeId={WORKTREE_ID} executionHostId={HOST_ID} />
    )
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
  mocks.retryBackgroundAgentLaunch.mockResolvedValue({ status: 'launched', receipt: {} })
  mocks.forgetBackgroundAgentLaunch.mockResolvedValue({ status: 'forgotten' })
  mocks.unknownAgentLaunchSiblingPreflight.mockResolvedValue({ count: 0, hostName: '' })
  mocks.forgetUnknownAgentLaunchSiblings.mockResolvedValue({ forgottenCount: 0 })
  mocks.confirm.mockResolvedValue(true)
  confirmBox.value = mocks.confirm
  worktreeBox.byHost.clear()
  storeBox.state = {
    // The container guards a missing worktreesByRepo slice (partial sibling-suite
    // mocks) before projecting meta; production always carries it, so seed a
    // truthy slice here — the mocked selector supplies the actual worktree.
    worktreesByRepo: {},
    retryBackgroundAgentLaunch: mocks.retryBackgroundAgentLaunch,
    forgetBackgroundAgentLaunch: mocks.forgetBackgroundAgentLaunch,
    unknownAgentLaunchSiblingPreflight: mocks.unknownAgentLaunchSiblingPreflight,
    forgetUnknownAgentLaunchSiblings: mocks.forgetUnknownAgentLaunchSiblings,
    openSettingsTarget: mocks.openSettingsTarget,
    openModal: mocks.openModal
  }
})

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount())
  }
  document.body.innerHTML = ''
})

describe('WorktreeCardBackgroundLaunchFailures', () => {
  it('renders nothing when the worktree carries no background attempts', async () => {
    await render()
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
  })

  it('selects the attempt row on the card host when worktree ids collide', async () => {
    worktreeBox.byHost.set('local', {
      backgroundAgentLaunches: [attempt({ failure: failure('unknown_agent') })]
    })
    worktreeBox.byHost.set(HOST_ID, {
      backgroundAgentLaunches: [
        attempt({ state: 'pending', failure: failure('launch_state_unknown') })
      ]
    })

    await render()

    expect(buttonByLabel('Reconnect')).toBeTruthy()
    expect(
      [...document.body.querySelectorAll('button')].some(
        (button) => button.textContent === 'Choose agent'
      )
    ).toBe(false)
  })

  it('renders nothing without throwing when the store omits the worktreesByRepo slice', async () => {
    // Reproduces the minimal sibling-suite store shape that made the indexed
    // worktree selector throw on Object.values(undefined) during G6's full run.
    storeBox.state = {
      retryBackgroundAgentLaunch: mocks.retryBackgroundAgentLaunch,
      forgetBackgroundAgentLaunch: mocks.forgetBackgroundAgentLaunch,
      openSettingsTarget: mocks.openSettingsTarget,
      openModal: mocks.openModal
    }
    await render()
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
  })

  it('renders nothing for launched/forgotten attempts (no surfacing failure)', async () => {
    worktreeBox.byHost.set(HOST_ID, {
      backgroundAgentLaunches: [
        attempt({ attemptId: 'a', state: 'launched', failure: null }),
        attempt({ attemptId: 'b', state: 'forgotten', failure: failure('spawn_failed') })
      ]
    })
    await render()
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
  })

  it('retries a failed attempt against its failure id, keyed by the attempt id', async () => {
    worktreeBox.byHost.set(HOST_ID, { backgroundAgentLaunches: [attempt()] })
    await render()
    await act(async () => {
      buttonByLabel('Retry').click()
    })
    expect(mocks.retryBackgroundAgentLaunch).toHaveBeenCalledExactlyOnceWith({
      attemptId: 'attempt-1',
      worktreeId: WORKTREE_ID,
      executionHostId: HOST_ID,
      expectedFailureId: 'failure-7',
      action: { kind: 'retry-same' }
    })
  })

  it('forgets an unknown attempt after the destructive confirmation, using its operation id as the guard', async () => {
    worktreeBox.byHost.set(HOST_ID, {
      backgroundAgentLaunches: [
        attempt({ state: 'pending', failure: failure('launch_state_unknown') })
      ]
    })
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
    expect(mocks.forgetBackgroundAgentLaunch).toHaveBeenCalledExactlyOnceWith({
      attemptId: 'attempt-1',
      worktreeId: WORKTREE_ID,
      executionHostId: HOST_ID,
      expectedOperationId: 'op-9'
    })
  })

  it('does not forget an unknown attempt when the destructive confirmation is declined', async () => {
    mocks.confirm.mockResolvedValue(false)
    worktreeBox.byHost.set(HOST_ID, {
      backgroundAgentLaunches: [
        attempt({ state: 'pending', failure: failure('launch_state_unknown') })
      ]
    })
    await render()
    await act(async () => {
      buttonByLabel('Forget launch…').click()
    })
    expect(mocks.confirm).toHaveBeenCalledOnce()
    expect(mocks.forgetBackgroundAgentLaunch).not.toHaveBeenCalled()
  })

  it('offers the sibling opt-in and bulk-forgets the worktree siblings when checked', async () => {
    mocks.unknownAgentLaunchSiblingPreflight.mockResolvedValue({ count: 2, hostName: 'devbox' })
    mocks.confirm.mockImplementation(
      async (options: { optIn?: { onConfirm: (checked: boolean) => void } }) => {
        options.optIn?.onConfirm(true)
        return true
      }
    )
    worktreeBox.byHost.set(HOST_ID, {
      backgroundAgentLaunches: [
        attempt({ state: 'pending', failure: failure('launch_state_unknown') })
      ]
    })
    await render()
    await act(async () => {
      buttonByLabel('Forget launch…').click()
    })
    expect(mocks.unknownAgentLaunchSiblingPreflight).toHaveBeenCalledExactlyOnceWith({
      worktreeId: WORKTREE_ID,
      executionHostId: HOST_ID
    })
    expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        optIn: expect.objectContaining({
          label: 'Also forget 2 other stranded launches on devbox.'
        })
      })
    )
    expect(mocks.forgetBackgroundAgentLaunch).toHaveBeenCalledExactlyOnceWith({
      attemptId: 'attempt-1',
      worktreeId: WORKTREE_ID,
      executionHostId: HOST_ID,
      expectedOperationId: 'op-9'
    })
    expect(mocks.forgetUnknownAgentLaunchSiblings).toHaveBeenCalledExactlyOnceWith({
      worktreeId: WORKTREE_ID,
      executionHostId: HOST_ID
    })
  })

  it('omits the opt-in and still forgets the attempt when the sibling preflight fails', async () => {
    mocks.unknownAgentLaunchSiblingPreflight.mockRejectedValue(new Error('unreachable'))
    worktreeBox.byHost.set(HOST_ID, {
      backgroundAgentLaunches: [
        attempt({ state: 'pending', failure: failure('launch_state_unknown') })
      ]
    })
    await render()
    await act(async () => {
      buttonByLabel('Forget launch…').click()
    })
    expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(
      expect.not.objectContaining({ optIn: expect.anything() })
    )
    expect(mocks.forgetBackgroundAgentLaunch).toHaveBeenCalledOnce()
    expect(mocks.forgetUnknownAgentLaunchSiblings).not.toHaveBeenCalled()
  })

  it('renders the recovery card and no-ops forget when no confirmation provider is mounted', async () => {
    // Host families (WorktreeCard/WorktreeList) render this card in isolation
    // without the ConfirmationDialogProvider; the soft hook returns null there.
    // The card must still render and the destructive forget must not fire
    // unconfirmed, rather than throwing and crashing the whole family.
    confirmBox.value = null
    worktreeBox.byHost.set(HOST_ID, {
      backgroundAgentLaunches: [
        attempt({ state: 'pending', failure: failure('launch_state_unknown') })
      ]
    })
    await render()
    expect(document.body.querySelector('[role="alert"]')).not.toBeNull()
    await act(async () => {
      buttonByLabel('Forget launch…').click()
    })
    expect(mocks.forgetBackgroundAgentLaunch).not.toHaveBeenCalled()
    expect(mocks.unknownAgentLaunchSiblingPreflight).not.toHaveBeenCalled()
  })

  it('routes reconnect on an unknown attempt to the ssh settings pane', async () => {
    worktreeBox.byHost.set(HOST_ID, {
      backgroundAgentLaunches: [
        attempt({ state: 'pending', failure: failure('launch_state_unknown') })
      ]
    })
    await render()
    await act(async () => {
      buttonByLabel('Reconnect').click()
    })
    expect(mocks.openSettingsTarget).toHaveBeenCalledExactlyOnceWith({ pane: 'ssh', repoId: null })
    expect(mocks.forgetBackgroundAgentLaunch).not.toHaveBeenCalled()
  })

  it('routes selection recovery to the desktop-host agents settings pane', async () => {
    worktreeBox.byHost.set(HOST_ID, {
      backgroundAgentLaunches: [attempt({ failure: failure('unknown_agent') })]
    })
    await render()
    await act(async () => {
      buttonByLabel('Choose agent').click()
    })
    expect(mocks.openSettingsTarget).toHaveBeenCalledExactlyOnceWith({
      pane: 'agents',
      repoId: null
    })
    expect(mocks.retryBackgroundAgentLaunch).not.toHaveBeenCalled()
  })

  it('renders one card per surfacing attempt', async () => {
    worktreeBox.byHost.set(HOST_ID, {
      backgroundAgentLaunches: [
        attempt({ attemptId: 'a' }),
        attempt({ attemptId: 'b', state: 'pending', failure: failure('launch_state_unknown') }),
        attempt({ attemptId: 'c', state: 'launched', failure: null })
      ]
    })
    await render()
    expect(document.body.querySelectorAll('[role="alert"]').length).toBe(2)
  })
})
