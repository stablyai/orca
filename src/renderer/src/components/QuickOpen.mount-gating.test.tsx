// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import QuickOpen from './QuickOpen'

const contentProbe = vi.hoisted(() => ({
  enabled: vi.fn(),
  renders: vi.fn(),
  storeNotifications: vi.fn(),
  subscriptions: vi.fn(),
  unsubscriptions: vi.fn()
}))

vi.mock('@/components/quick-open-file-list', async () => {
  const React = await import('react')
  return {
    useRuntimeFileListForWorktree: ({ enabled }: { enabled: boolean }) => {
      contentProbe.enabled(enabled)
      contentProbe.renders()
      React.useEffect(() => {
        contentProbe.subscriptions()
        const unsubscribe = useAppStore.subscribe(() => contentProbe.storeNotifications())
        return () => {
          contentProbe.unsubscriptions()
          unsubscribe()
        }
      }, [])
      return { files: [], loading: false, loadError: null, truncated: false }
    }
  }
})

vi.mock('@/hooks/useModalReturnFocus', () => ({
  useModalReturnFocus: () => ({ captureReturnFocus: vi.fn(), skipReturnFocus: vi.fn() })
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/components/ui/command', () => {
  return {
    CommandDialog: ({ children, open }: { children: ReactNode; open?: boolean }) =>
      open ? <div data-command-dialog="true">{children}</div> : null,
    CommandInput: () => <input data-command-input="true" />,
    CommandList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    CommandEmpty: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    CommandItem: ({ children }: { children: ReactNode }) => <div>{children}</div>
  }
})

const initialAppState = useAppStore.getInitialState()
let testContainer: HTMLDivElement
let testRoot: Root

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function activeContentSubscriptions(): number {
  return (
    contentProbe.subscriptions.mock.calls.length - contentProbe.unsubscriptions.mock.calls.length
  )
}

async function churnClosedStore(count: number): Promise<void> {
  await act(async () => {
    for (let index = 0; index < count; index += 1) {
      useAppStore.setState({ activeWorktreeId: `remote-background-${index}` })
    }
  })
}

describe('QuickOpen mount gating', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    contentProbe.enabled.mockClear()
    contentProbe.renders.mockClear()
    contentProbe.storeNotifications.mockClear()
    contentProbe.subscriptions.mockClear()
    contentProbe.unsubscriptions.mockClear()
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({ activeModal: 'quick-open', activeWorktreeId: null })
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

  it('unmounts subscribed content after the close linger', async () => {
    await act(async () => testRoot.render(<QuickOpen />))
    await flushEffects()

    expect(testContainer.querySelector('[data-command-dialog="true"]')).not.toBeNull()
    expect(activeContentSubscriptions()).toBe(1)

    await act(async () => useAppStore.setState({ activeModal: 'none' }))

    expect(testContainer.querySelector('[data-command-dialog="true"]')).toBeNull()
    expect(contentProbe.enabled).toHaveBeenLastCalledWith(false)
    expect(activeContentSubscriptions()).toBe(1)

    await act(async () => vi.advanceTimersByTimeAsync(299))
    expect(activeContentSubscriptions()).toBe(1)

    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(activeContentSubscriptions()).toBe(0)

    const rendersAfterUnmount = contentProbe.renders.mock.calls.length
    const notificationsAfterUnmount = contentProbe.storeNotifications.mock.calls.length
    await churnClosedStore(1_000)

    expect(contentProbe.renders).toHaveBeenCalledTimes(rendersAfterUnmount)
    expect(contentProbe.storeNotifications).toHaveBeenCalledTimes(notificationsAfterUnmount)
  })

  it('cancels the pending unmount when reopened during the linger', async () => {
    await act(async () => testRoot.render(<QuickOpen />))
    await flushEffects()

    await act(async () => useAppStore.setState({ activeModal: 'none' }))
    await act(async () => vi.advanceTimersByTimeAsync(299))
    await act(async () => useAppStore.setState({ activeModal: 'quick-open' }))
    await act(async () => vi.advanceTimersByTimeAsync(1_000))

    expect(testContainer.querySelector('[data-command-dialog="true"]')).not.toBeNull()
    expect(activeContentSubscriptions()).toBe(1)
  })
})
