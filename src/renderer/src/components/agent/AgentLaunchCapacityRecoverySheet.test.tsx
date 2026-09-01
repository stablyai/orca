// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentLaunchCapacityRecoverySheet from './AgentLaunchCapacityRecoverySheet'
import type { PendingAgentLaunchSummaryRow } from '../../../../shared/agent-launch-pending-summary'

const storeBox = vi.hoisted(() => ({ state: null as unknown }))
const localeBox = vi.hoisted(() => ({ value: 'en' }))
const summaryBox = vi.hoisted(() => ({
  rows: [] as readonly PendingAgentLaunchSummaryRow[],
  reject: false
}))

const mocks = vi.hoisted(() => ({
  closeModal: vi.fn(),
  fetchPendingAgentLaunchSummary: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  setPendingAutomationRunNavigation: vi.fn(),
  openAutomationsPage: vi.fn(),
  onChanged: vi.fn((_cb: () => void) => () => {}),
  subscribeRuntimeClientEvents: vi.fn(),
  unsubscribeRuntimeClientEvents: vi.fn()
}))

vi.mock('@/runtime/runtime-client-events', () => ({
  subscribeRuntimeClientEvents: mocks.subscribeRuntimeClientEvents
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(storeBox.state), {
    getState: () => storeBox.state
  })
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/lib/agent-catalog', () => ({
  getAgentLabel: (agent: string) => agent
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback,
  // The real relative-time formatter reads the app's UI language through this.
  getIntlLocale: () => localeBox.value
}))

vi.mock('@/components/ui/button', () => ({
  Button: (props: { children?: unknown; onClick?: () => void }) => (
    <button type="button" onClick={props.onClick}>
      {props.children as never}
    </button>
  )
}))

vi.mock('@/components/ui/sheet', () => ({
  Sheet: (props: { open?: boolean; children?: unknown }) =>
    props.open ? <div>{props.children as never}</div> : null,
  SheetContent: (props: { children?: unknown }) => <div>{props.children as never}</div>,
  SheetHeader: (props: { children?: unknown }) => <div>{props.children as never}</div>,
  SheetTitle: (props: { children?: unknown }) => <div>{props.children as never}</div>,
  SheetDescription: (props: { children?: unknown }) => <div>{props.children as never}</div>
}))

const mountedRoots: Root[] = []

async function render(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(<AgentLaunchCapacityRecoverySheet />)
  })
  // Let the open-effect's fetch promise resolve and re-render.
  await act(async () => {
    await Promise.resolve()
  })
}

function textContent(): string {
  return document.body.textContent ?? ''
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
  mocks.onChanged.mockReturnValue(() => {})
  mocks.subscribeRuntimeClientEvents.mockResolvedValue({
    unsubscribe: mocks.unsubscribeRuntimeClientEvents
  })
  mocks.fetchPendingAgentLaunchSummary.mockImplementation(async () => {
    if (summaryBox.reject) {
      throw new Error('boom')
    }
    return { rows: summaryBox.rows }
  })
  summaryBox.rows = []
  summaryBox.reject = false
  localeBox.value = 'en'
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = {
    worktrees: { onChanged: mocks.onChanged }
  }
  storeBox.state = {
    activeModal: 'agent-launch-capacity-recovery',
    modalData: {},
    closeModal: mocks.closeModal,
    fetchPendingAgentLaunchSummary: mocks.fetchPendingAgentLaunchSummary,
    setPendingAutomationRunNavigation: mocks.setPendingAutomationRunNavigation,
    openAutomationsPage: mocks.openAutomationsPage
  }
})

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount())
  }
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('AgentLaunchCapacityRecoverySheet', () => {
  it('renders nothing when the modal is not active', async () => {
    storeBox.state = { ...(storeBox.state as object), activeModal: 'none' }
    await render()
    expect(mocks.fetchPendingAgentLaunchSummary).not.toHaveBeenCalled()
    expect(textContent()).toBe('')
  })

  it('shows the empty state when no launches are pending', async () => {
    summaryBox.rows = []
    await render()
    expect(mocks.fetchPendingAgentLaunchSummary).toHaveBeenCalledTimes(1)
    expect(textContent()).toContain('Launch capacity is currently clear')
  })

  it('renders a worktree row and deep-links to its workspace on action', async () => {
    summaryBox.rows = [
      {
        sourceKind: 'interactive',
        baseHarness: 'claude',
        targetHostDisplayName: 'This Mac',
        admittedAt: Date.now(),
        liveness: 'unknown',
        deepLink: { kind: 'worktree', worktreeId: 'repo1::/tmp/wt' }
      }
    ]
    await render()
    expect(textContent()).toContain('claude')
    expect(textContent()).toContain('This Mac')

    await act(async () => {
      buttonByLabel('Go to workspace').click()
    })
    expect(mocks.closeModal).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo1::/tmp/wt')
  })

  it('renders a run row and navigates to its owning automation run on action', async () => {
    summaryBox.rows = [
      {
        sourceKind: 'automation',
        baseHarness: 'claude',
        targetHostDisplayName: 'This Mac',
        admittedAt: Date.now(),
        liveness: 'absent',
        deepLink: { kind: 'run', runId: 'run-1', automationId: 'auto-1' }
      }
    ]
    await render()

    await act(async () => {
      buttonByLabel('Go to run').click()
    })
    expect(mocks.closeModal).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.setPendingAutomationRunNavigation).toHaveBeenCalledWith({
      automationId: 'auto-1',
      runId: 'run-1'
    })
    expect(mocks.openAutomationsPage).toHaveBeenCalledTimes(1)
  })

  it('labels the action Open for a live row', async () => {
    summaryBox.rows = [
      {
        sourceKind: 'cli',
        baseHarness: 'codex',
        targetHostDisplayName: 'This Mac',
        admittedAt: Date.now(),
        liveness: 'live',
        deepLink: { kind: 'worktree', worktreeId: 'wt-live' }
      }
    ]
    await render()
    expect(buttonByLabel('Open')).toBeTruthy()
  })

  it('formats the admitted time in the app UI language, not the OS locale', async () => {
    const admittedAt = Date.now() - 3 * 3_600_000
    summaryBox.rows = [
      {
        sourceKind: 'cli',
        baseHarness: 'codex',
        targetHostDisplayName: 'This Mac',
        admittedAt,
        liveness: 'live',
        deepLink: { kind: 'worktree', worktreeId: 'wt-1' }
      }
    ]
    localeBox.value = 'ja'
    await render()

    const japanese = new Intl.RelativeTimeFormat('ja', { numeric: 'auto' }).format(-3, 'hour')
    const english = new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-3, 'hour')
    expect(japanese).not.toBe(english)
    expect(textContent()).toContain(japanese)
    expect(textContent()).not.toContain(english)
  })

  it('surfaces a retryable message when the fetch fails', async () => {
    summaryBox.reject = true
    await render()
    expect(textContent()).toContain("Couldn't load pending launches")
  })

  it('refetches on the worktrees:changed event', async () => {
    await render()
    expect(mocks.onChanged).toHaveBeenCalledTimes(1)
    const handler = mocks.onChanged.mock.calls[0][0]
    await act(async () => {
      handler()
      await Promise.resolve()
    })
    expect(mocks.fetchPendingAgentLaunchSummary).toHaveBeenCalledTimes(2)
  })

  it('does not open a remote event stream for a local target', async () => {
    await render()
    expect(mocks.subscribeRuntimeClientEvents).not.toHaveBeenCalled()
  })

  it('refetches on the remote runtime worktreesChanged event', async () => {
    storeBox.state = {
      ...(storeBox.state as object),
      modalData: { target: { kind: 'environment', environmentId: 'env-1' } }
    }
    await render()
    expect(mocks.subscribeRuntimeClientEvents).toHaveBeenCalledWith('env-1', expect.any(Function))
    const onEvent = mocks.subscribeRuntimeClientEvents.mock.calls[0][1]

    await act(async () => {
      onEvent({ type: 'reposChanged' })
      await Promise.resolve()
    })
    expect(mocks.fetchPendingAgentLaunchSummary).toHaveBeenCalledTimes(1)

    await act(async () => {
      onEvent({ type: 'worktreesChanged', repoId: 'repo-1' })
      await Promise.resolve()
    })
    expect(mocks.fetchPendingAgentLaunchSummary).toHaveBeenCalledTimes(2)
  })

  it('closes the remote event stream when the sheet unmounts', async () => {
    storeBox.state = {
      ...(storeBox.state as object),
      modalData: { target: { kind: 'environment', environmentId: 'env-1' } }
    }
    await render()
    await act(async () => {
      await Promise.resolve()
    })

    for (const root of mountedRoots.splice(0)) {
      act(() => root.unmount())
    }
    expect(mocks.unsubscribeRuntimeClientEvents).toHaveBeenCalledTimes(1)
  })
})
