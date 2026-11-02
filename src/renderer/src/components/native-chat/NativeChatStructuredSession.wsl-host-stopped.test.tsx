// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WslHostStatus } from '../../../../shared/wsl-host-types'

const { moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)
const reconnectHost = vi.hoisted(() =>
  vi.fn<(environmentId: string, failureMessage?: string) => Promise<boolean>>()
)

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

afterEach(() => {
  cleanup()
  resetStructuredSessionMocks()
  reconnectHost.mockReset()
  useAppStore.setState({ wslHostStatuses: initialState.wslHostStatuses })
})

it('names a stopped WSL distro above the composer and offers Start', async () => {
  renderPane()
  expect(screen.queryByText(/is stopped/)).toBeNull()
  setWslStatus('distro-stopped')

  expect(screen.getByText('Ubuntu is stopped')).toHaveClass('text-destructive')
  expect(screen.getByRole('listitem')).toHaveAttribute('data-notice-kind', 'host')
  reconnectHost.mockResolvedValue(true)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
  })
  // Start is the explicit act that may boot the distro (E9): one connect, which reconnects the chat.
  expect(reconnectHost).toHaveBeenCalledOnce()
  expect(reconnectHost).toHaveBeenCalledWith(
    'wsl:ubuntu',
    'Couldn’t start Ubuntu. Check it in Settings → Remote Orca Servers.'
  )

  setWslStatus('ready')
  expect(screen.queryByText('Ubuntu is stopped')).toBeNull()
})

it('still offers Start after a start that failed', async () => {
  renderPane()
  setWslStatus('distro-stopped')
  reconnectHost.mockResolvedValue(false)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
  })
  expect(screen.getByText('Ubuntu is stopped')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled()
})

it('leaves an idle WSL host to reconnect on its own', () => {
  renderPane()
  setWslStatus('idle')
  expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
})
