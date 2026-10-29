// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WslHostStatus } from '../../../../shared/wsl-host-types'

const { moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)
const reconnectHost = vi.hoisted(() => vi.fn<(environmentId: string) => Promise<boolean>>())
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))

vi.mock('@/runtime/structured-agent-session-client', () =>
  moduleFactories.structuredAgentSessionClient()
)
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('./use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())
vi.mock('@/components/status-bar/runtime-environment-explicit-connect', () => ({
  connectRuntimeHostAndReloadProjects: reconnectHost
}))

import { useAppStore } from '@/store'
import { NativeChatStructuredSession } from './NativeChatStructuredSession'

const initialState = useAppStore.getState()
const startHost =
  vi.fn<(args: { environmentId: string; withdrawPendingRemoval?: boolean }) => Promise<void>>()

function setWslStatus(state: WslHostStatus['state']): void {
  act(() => {
    useAppStore.setState({
      wslHostStatuses: {
        'wsl:ubuntu': { environmentId: 'wsl:ubuntu', distro: 'Ubuntu', state, detail: null }
      }
    })
  })
}

function renderPane() {
  return render(
    <NativeChatStructuredSession
      isVisible
      isFocusedGroup
      tabId="structured-wsl-stopped-tab"
      sessionId="wsl-stopped-session"
      target={{ kind: 'environment', environmentId: 'wsl:ubuntu' }}
      agent="claude"
    />
  )
}

beforeEach(() => {
  vi.stubGlobal('api', {
    ...window.api,
    runtimeEnvironments: { ...window.api?.runtimeEnvironments, wslHosts: { connect: startHost } }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetStructuredSessionMocks()
  reconnectHost.mockReset()
  startHost.mockReset()
  toastError.mockReset()
  useAppStore.setState({ wslHostStatuses: initialState.wslHostStatuses })
})

it('names a stopped WSL distro above the composer and offers Start', async () => {
  renderPane()
  expect(screen.queryByText(/is stopped/)).toBeNull()
  setWslStatus('distro-stopped')

  expect(screen.getByText('Ubuntu is stopped')).toHaveClass('text-destructive')
  expect(screen.getByRole('listitem')).toHaveAttribute('data-notice-kind', 'host')
  startHost.mockResolvedValue()
  reconnectHost.mockResolvedValue(true)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
  })
  // Start is the explicit act that may boot the distro (E9); the chat then reconnects.
  // Never cancels a Remove the user started: main refuses with its pending-removal words.
  expect(startHost).toHaveBeenCalledWith({
    environmentId: 'wsl:ubuntu',
    withdrawPendingRemoval: false
  })
  expect(reconnectHost).toHaveBeenCalledWith('wsl:ubuntu')

  setWslStatus('ready')
  expect(screen.queryByText('Ubuntu is stopped')).toBeNull()
})

it('shows the refusal and does not reconnect when the distro could not be started', async () => {
  renderPane()
  setWslStatus('distro-stopped')
  // Main's refusal for a host whose Remove is pending, shown as main words it.
  const pending = 'Orca didn’t finish removing the WSL host Ubuntu.'
  startHost.mockRejectedValue(new Error(pending))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
  })
  expect(toastError).toHaveBeenCalledWith(pending)
  expect(reconnectHost).not.toHaveBeenCalled()
})

it('leaves an idle WSL host to reconnect on its own', () => {
  renderPane()
  setWslStatus('idle')
  expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
})
