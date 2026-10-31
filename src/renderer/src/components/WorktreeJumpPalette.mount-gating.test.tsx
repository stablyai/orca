// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactI18Next from 'react-i18next'
import { useAppStore } from '@/store'
import WorktreeJumpPalette from './WorktreeJumpPalette'

const contentProbe = vi.hoisted(() => ({
  renders: vi.fn(),
  storeNotifications: vi.fn(),
  subscriptions: vi.fn(),
  unsubscriptions: vi.fn()
}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18Next>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: string) => fallback ?? _key
    })
  }
})

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn()
  }
}))

vi.mock('@/hooks/useSettingsNavigationMetadata', async () => {
  const React = await import('react')
  return {
    useSettingsNavigationMetadata: () => {
      contentProbe.renders()
      React.useEffect(() => {
        contentProbe.subscriptions()
        const unsubscribe = useAppStore.subscribe(() => contentProbe.storeNotifications())
        return () => {
          contentProbe.unsubscriptions()
          unsubscribe()
        }
      }, [])
      return []
    }
  }
})

vi.mock('@/components/sidebar/StatusIndicator', () => ({
  default: () => <span data-status-indicator="true" />
}))

vi.mock('@/components/repo/RepoBadgeLabel', () => ({
  RepoBadgeMark: () => <span data-repo-badge-mark="true" />
}))

vi.mock('@/components/cmd-j/palette-host-badge', () => ({
  getPaletteHostBadge: () => null
}))

vi.mock('@/components/ui/command', async () => {
  const React = await import('react')
  return {
    Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandDialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
      open ? <div data-command-dialog="true">{children}</div> : null,
    CommandInput: React.forwardRef(function CommandInput(
      _props: Record<string, unknown>,
      ref: React.ForwardedRef<HTMLInputElement>
    ) {
      return <input ref={ref} data-command-input="true" />
    }),
    CommandList: React.forwardRef(function CommandList(
      { children }: { children: React.ReactNode },
      ref: React.ForwardedRef<HTMLDivElement>
    ) {
      return <div ref={ref}>{children}</div>
    }),
    CommandEmpty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandItem: ({ children }: { children: React.ReactNode }) => (
      <button type="button">{children}</button>
    )
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

describe('WorktreeJumpPalette mount gating', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    contentProbe.renders.mockClear()
    contentProbe.storeNotifications.mockClear()
    contentProbe.subscriptions.mockClear()
    contentProbe.unsubscriptions.mockClear()
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

  it('mounts content on demand and unmounts it after the close linger', async () => {
    await act(async () => testRoot.render(<WorktreeJumpPalette />))
    await flushEffects()

    await churnClosedStore(1_000)

    expect(contentProbe.renders).not.toHaveBeenCalled()
    expect(contentProbe.subscriptions).not.toHaveBeenCalled()
    expect(contentProbe.storeNotifications).not.toHaveBeenCalled()

    await act(async () => {
      useAppStore.getState().openModal('worktree-palette')
    })
    await flushEffects()

    expect(testContainer.querySelector('[data-command-dialog="true"]')).not.toBeNull()
    expect(contentProbe.renders).toHaveBeenCalled()
    expect(activeContentSubscriptions()).toBe(1)

    await act(async () => {
      useAppStore.getState().closeModal()
    })

    expect(testContainer.querySelector('[data-command-dialog="true"]')).toBeNull()
    expect(activeContentSubscriptions()).toBe(1)

    await act(async () => vi.advanceTimersByTimeAsync(299))
    expect(activeContentSubscriptions()).toBe(1)

    const lingerNotifications = contentProbe.storeNotifications.mock.calls.length
    await act(async () => useAppStore.setState({ activeWorktreeId: 'during-close-linger' }))
    expect(contentProbe.storeNotifications).toHaveBeenCalledTimes(lingerNotifications + 1)

    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(activeContentSubscriptions()).toBe(0)

    const rendersAfterUnmount = contentProbe.renders.mock.calls.length
    const notificationsAfterUnmount = contentProbe.storeNotifications.mock.calls.length
    await churnClosedStore(100)

    expect(contentProbe.renders).toHaveBeenCalledTimes(rendersAfterUnmount)
    expect(contentProbe.storeNotifications).toHaveBeenCalledTimes(notificationsAfterUnmount)
  })

  it('cancels the pending unmount when reopened during the linger', async () => {
    await act(async () => testRoot.render(<WorktreeJumpPalette />))
    await act(async () => useAppStore.getState().openModal('worktree-palette'))
    await flushEffects()

    await act(async () => useAppStore.getState().closeModal())
    await act(async () => vi.advanceTimersByTimeAsync(299))
    await act(async () => useAppStore.getState().openModal('worktree-palette'))
    await act(async () => vi.advanceTimersByTimeAsync(1_000))

    expect(testContainer.querySelector('[data-command-dialog="true"]')).not.toBeNull()
    expect(activeContentSubscriptions()).toBe(1)
  })
})
