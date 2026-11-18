// @vitest-environment happy-dom
import { Activity, StrictMode } from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { NativeChatPaneLifetime } from '../pane/ownership/native-chat-pane-lifetime'
import { NativeChatComposerNotices } from '../composer/controls/NativeChatComposerNotices'
import { NativeChatHostOutageOwner } from './native-chat-host-outage-owner'
import { useNativeChatHostOutage } from './use-native-chat-host-outage'
import { useNativeChatHostOutageNotice } from './use-native-chat-host-outage-notice'

function hostStatus(state: 'closed' | 'awaiting_ready' | 'ready', verified = false) {
  return {
    status: verified
      ? {
          runtimeId: 'qa-runtime',
          rendererGraphEpoch: 0,
          graphStatus: 'ready' as const,
          authoritativeWindowId: 1,
          liveTabCount: 1,
          liveLeafCount: 1
        }
      : null,
    checkedAt: 0,
    hostContactEpoch: 0,
    remoteControl: {
      state,
      pendingRequestCount: 0,
      subscriptionCount: 0,
      reconnectAttempt: 0,
      lastConnectedAt: null,
      lastClose: null,
      lastError: null
    }
  }
}

const mocks = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  return {
    useAppStore: create(() => ({
      runtimeStatusByEnvironmentId: new Map([['qa-host', hostStatus('closed')]]),
      wslHostStatuses: {}
    }))
  }
})
vi.mock('@/runtime/hosts/display/execution-host-display-label', () => ({
  selectExecutionHostDisplayLabel: () => 'QA host'
}))
vi.mock('@/i18n/use-translate', () => ({
  useTranslate: () => (_key: string, fallback: string) => fallback
}))
vi.mock('@/components/status-bar/host-connections/runtime-environment-explicit-connect', () => ({
  connectRuntimeHostAndReloadProjects: mocks.connect
}))

function HostComposer() {
  const outage = useNativeChatHostOutage({ kind: 'environment', environmentId: 'qa-host' })
  const notice = useNativeChatHostOutageNotice(outage)
  return <NativeChatComposerNotices notices={notice ? [notice] : []} />
}

it('keeps a pending manual reconnect available across a chat switch', async () => {
  let finish!: () => void
  mocks.connect.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const pane = (visible: boolean) => (
    <StrictMode>
      <NativeChatPaneLifetime isVisible={visible}>
        <NativeChatHostOutageOwner target={{ kind: 'environment', environmentId: 'qa-host' }}>
          <Activity mode={visible ? 'visible' : 'hidden'}>
            <HostComposer />
          </Activity>
        </NativeChatHostOutageOwner>
      </NativeChatPaneLifetime>
    </StrictMode>
  )
  const view = render(pane(true))
  try {
    fireEvent.click(view.getByRole('button', { name: 'Reconnect' }))
    act(() =>
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([['qa-host', hostStatus('awaiting_ready')]])
      })
    )
    expect(view.getByRole('button', { name: 'Reconnect' }).hasAttribute('disabled')).toBe(true)
    view.rerender(pane(false))
    await act(async () => {})
    view.rerender(pane(true))
    expect(view.getByRole('button', { name: 'Reconnect' }).hasAttribute('disabled')).toBe(true)
    await act(async () => {
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([['qa-host', hostStatus('closed')]])
      })
      finish()
    })
    expect(view.getByRole('button', { name: 'Reconnect' }).hasAttribute('disabled')).toBe(false)
  } finally {
    view.unmount()
    await act(async () => {})
    mocks.connect.mockReset()
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([['qa-host', hostStatus('closed')]])
    })
  }
})

it('starts a new outage after the host recovers while its chat is hidden', async () => {
  const pane = (visible: boolean) => (
    <NativeChatPaneLifetime isVisible={visible}>
      <NativeChatHostOutageOwner target={{ kind: 'environment', environmentId: 'qa-host' }}>
        <Activity mode={visible ? 'visible' : 'hidden'}>
          <HostComposer />
        </Activity>
      </NativeChatHostOutageOwner>
    </NativeChatPaneLifetime>
  )
  const view = render(pane(true))
  try {
    expect(view.getByRole('button', { name: 'Reconnect' })).toBeTruthy()
    view.rerender(pane(false))
    act(() => useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() }))
    act(() =>
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([['qa-host', hostStatus('awaiting_ready')]])
      })
    )
    view.rerender(pane(true))
    expect(view.getByRole('button', { name: 'Reconnect' })).toBeTruthy()
    view.rerender(pane(false))
    act(() =>
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([['qa-host', hostStatus('ready', true)]])
      })
    )
    act(() =>
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([['qa-host', hostStatus('awaiting_ready', true)]])
      })
    )
    view.rerender(pane(true))
    expect(view.queryByRole('button', { name: 'Reconnect' })).toBeNull()
  } finally {
    view.unmount()
    await act(async () => {})
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([['qa-host', hostStatus('closed')]])
    })
  }
})

it('shows an outage that earned its grace while the chat was hidden', async () => {
  vi.useFakeTimers()
  useAppStore.setState({
    runtimeStatusByEnvironmentId: new Map([['qa-host', hostStatus('ready', true)]])
  })
  const pane = (visible: boolean) => (
    <NativeChatPaneLifetime isVisible={visible}>
      <NativeChatHostOutageOwner target={{ kind: 'environment', environmentId: 'qa-host' }}>
        <Activity mode={visible ? 'visible' : 'hidden'}>
          <HostComposer />
        </Activity>
      </NativeChatHostOutageOwner>
    </NativeChatPaneLifetime>
  )
  const view = render(pane(false))
  try {
    act(() => {
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([['qa-host', hostStatus('awaiting_ready', true)]])
      })
      vi.advanceTimersByTime(3000)
    })
    view.rerender(pane(true))
    expect(view.getByRole('listitem')).toBeTruthy()
    expect(view.queryByRole('button', { name: 'Reconnect' })).toBeNull()
  } finally {
    view.unmount()
    await act(async () => {})
    vi.useRealTimers()
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([['qa-host', hostStatus('closed')]])
    })
  }
})
