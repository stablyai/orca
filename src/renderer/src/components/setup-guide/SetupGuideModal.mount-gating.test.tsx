// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURE_WALL_SETUP_STEPS } from '../../../../shared/feature-wall-setup-steps'
import type { FeatureWallSetupProgress } from '../feature-wall/feature-wall-setup-progress'
import { useAppStore } from '@/store'
import SetupGuideModal from './SetupGuideModal'

const contentProbe = vi.hoisted(() => ({
  renders: vi.fn(),
  storeNotifications: vi.fn(),
  subscriptions: vi.fn(),
  unsubscriptions: vi.fn(),
  telemetryOpenStates: vi.fn(),
  refreshEnabledStates: vi.fn()
}))

const progress: FeatureWallSetupProgress = {
  ready: true,
  stepDone: {
    'default-agent': false,
    'add-two-repos': false,
    notifications: false,
    'two-worktrees': false,
    browser: false,
    'task-sources': false,
    'agent-capabilities': false,
    'setup-script': false
  },
  coreDoneCount: 0,
  coreTotal: FEATURE_WALL_SETUP_STEPS.length
}

vi.mock('./use-setup-guide-progress', async () => {
  const React = await import('react')
  return {
    useSetupGuideProgress: (shouldRefreshCoreState: boolean) => {
      contentProbe.renders()
      contentProbe.refreshEnabledStates(shouldRefreshCoreState)
      useAppStore((state) => state.activeWorktreeId)
      React.useEffect(() => {
        contentProbe.subscriptions()
        const unsubscribe = useAppStore.subscribe(() => contentProbe.storeNotifications())
        return () => {
          contentProbe.unsubscriptions()
          unsubscribe()
        }
      }, [])
      return progress
    }
  }
})

vi.mock('./use-setup-guide-telemetry', () => ({
  useSetupGuideOpenCloseTelemetry: ({ isOpen }: { isOpen: boolean }) =>
    contentProbe.telemetryOpenStates(isOpen)
}))

vi.mock('../feature-wall/FeatureWallSetupChecklist', () => ({
  FeatureWallSetupChecklist: () => <div data-setup-guide-content="true" />
}))

vi.mock('./SetupGuideProgressRing', () => ({
  SetupGuideProgressRing: () => <span />
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? <div data-setup-guide-dialog="true">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>
}))

const initialAppState = useAppStore.getInitialState()
let testContainer: HTMLDivElement
let testRoot: Root

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function churnClosedStore(count: number): Promise<void> {
  await act(async () => {
    for (let index = 0; index < count; index += 1) {
      useAppStore.setState({ activeWorktreeId: `background-${index}` })
    }
  })
}

function activeContentSubscriptions(): number {
  return (
    contentProbe.subscriptions.mock.calls.length - contentProbe.unsubscriptions.mock.calls.length
  )
}

describe('SetupGuideModal mount gating', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    contentProbe.renders.mockClear()
    contentProbe.storeNotifications.mockClear()
    contentProbe.subscriptions.mockClear()
    contentProbe.unsubscriptions.mockClear()
    contentProbe.telemetryOpenStates.mockClear()
    contentProbe.refreshEnabledStates.mockClear()
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({ activeModal: 'none', activeWorktreeId: null })
    testContainer = document.createElement('div')
    document.body.appendChild(testContainer)
    testRoot = createRoot(testContainer)
  })

  afterEach(async () => {
    await act(async () => testRoot.unmount())
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('releases setup content after the close animation', async () => {
    await act(async () => testRoot.render(<SetupGuideModal />))
    await flushEffects()

    await churnClosedStore(1_000)

    expect(contentProbe.renders).not.toHaveBeenCalled()
    expect(contentProbe.subscriptions).not.toHaveBeenCalled()
    expect(contentProbe.storeNotifications).not.toHaveBeenCalled()

    await act(async () => useAppStore.getState().openModal('setup-guide'))
    await flushEffects()

    expect(testContainer.querySelector('[data-setup-guide-dialog="true"]')).not.toBeNull()
    expect(activeContentSubscriptions()).toBe(1)

    await act(async () => useAppStore.getState().closeModal())

    expect(testContainer.querySelector('[data-setup-guide-dialog="true"]')).toBeNull()
    expect(activeContentSubscriptions()).toBe(1)
    expect(contentProbe.telemetryOpenStates).toHaveBeenLastCalledWith(false)
    // Why: dropping progress inputs mid-fade would flip completed rows back to "not done yet".
    expect(contentProbe.refreshEnabledStates).toHaveBeenLastCalledWith(true)

    await act(async () => vi.advanceTimersByTimeAsync(299))
    expect(activeContentSubscriptions()).toBe(1)
    expect(contentProbe.refreshEnabledStates).toHaveBeenLastCalledWith(true)

    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(activeContentSubscriptions()).toBe(0)

    const rendersAfterUnmount = contentProbe.renders.mock.calls.length
    const notificationsAfterUnmount = contentProbe.storeNotifications.mock.calls.length
    await churnClosedStore(1_000)

    expect(contentProbe.renders).toHaveBeenCalledTimes(rendersAfterUnmount)
    expect(contentProbe.storeNotifications).toHaveBeenCalledTimes(notificationsAfterUnmount)
  })

  it('cancels the pending unmount when reopened during the linger', async () => {
    await act(async () => testRoot.render(<SetupGuideModal />))
    await act(async () => useAppStore.getState().openModal('setup-guide'))
    await flushEffects()

    await act(async () => useAppStore.getState().closeModal())
    await act(async () => vi.advanceTimersByTimeAsync(299))
    await act(async () => useAppStore.getState().openModal('setup-guide'))
    await act(async () => vi.advanceTimersByTimeAsync(1_000))

    expect(testContainer.querySelector('[data-setup-guide-dialog="true"]')).not.toBeNull()
    expect(activeContentSubscriptions()).toBe(1)

    // Why: an uncancelled timer from the first close would have already cleared the
    // linger flag, collapsing this second close into a synchronous unmount that
    // reports 'interrupted' instead of 'dismissed'.
    await act(async () => useAppStore.getState().closeModal())
    expect(activeContentSubscriptions()).toBe(1)
    await act(async () => vi.advanceTimersByTimeAsync(299))
    expect(activeContentSubscriptions()).toBe(1)
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(activeContentSubscriptions()).toBe(0)
  })
})
