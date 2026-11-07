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
