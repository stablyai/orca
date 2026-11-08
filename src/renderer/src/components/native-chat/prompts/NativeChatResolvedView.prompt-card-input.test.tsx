// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AgentStatusPayload } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import type { NativeChatLiveSession } from '../session/terminal/read/native-chat-live-session-contract'

// The composer is a marker that counts its mounts, so the test sees whether the view remounted it.
const retained = vi.hoisted((): { session: NativeChatLiveSession | null } => ({ session: null }))
const composer = vi.hoisted(() => ({ mounts: 0 }))
const ptyInput = vi.hoisted(() => ({ verified: vi.fn<() => Promise<boolean>>() }))
vi.mock('../session/terminal/read/use-native-chat-retained-session', () => ({
  useNativeChatRetainedSession: () => retained.session
}))
vi.mock('../composer/NativeChatComposer', async () => {
  const { useEffect } = await import('react')
  return {
    NativeChatComposer: () => {
      useEffect(() => {
        composer.mounts += 1
      }, [])
      return <div data-testid="native-chat-composer" />
    }
  }
})
vi.mock('@/runtime/hosted-terminals/input/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: ptyInput.verified
}))

const { NativeChatResolvedView } = await import('../NativeChatResolvedView')
const { TooltipProvider } = await import('@/components/ui/tooltip')
const { nativeChatPromptDismissals } = await import('./native-chat-prompt-dismissals')
const { useAppStore } = await import('../../../store/index')
const { installNativeChatMessageListTestViewport } =
  await import('../viewport/virtualization/native-chat-message-list-test-viewport')

const paneKey = 'tab-card:leaf-card'
let restoreViewport = (): void => {}

const userTurn: NativeChatMessage = {
  id: 'user-1',
  role: 'user',
  blocks: [{ type: 'text', text: 'Clean the build' }],
  timestamp: 1,
  source: 'transcript'
}

function transcript(): NativeChatLiveSession {
  return {
    messages: [userTurn],
    status: 'ready',
    sessionId: 'session-card',
    agent: 'claude',
    hookAwaitingInput: true,
    hasMore: false,
    loadingEarlier: false,
    olderHistoryGeneration: 0,
    loadEarlier: vi.fn(),
    readPhase: 'ready'
  }
}

function setStatus(
  payload: Omit<AgentStatusPayload, 'prompt' | 'agentType'>,
  stateStartedAt?: number
): void {
  useAppStore
    .getState()
    .setAgentStatus(
      paneKey,
      { prompt: 'Clean the build', agentType: 'claude', ...payload },
      undefined,
      stateStartedAt === undefined ? undefined : { stateStartedAt }
    )
}

function renderPane(targetPtyId = 'pty-card'): ReturnType<typeof render> {
  return render(paneElement(targetPtyId))
}

function paneElement(targetPtyId = 'pty-card'): React.JSX.Element {
  return (
    <TooltipProvider>
      <NativeChatResolvedView
        paneKey={paneKey}
        agent="claude"
        sessionId="session-card"
        transcriptPath={null}
        isVisible
        isFocusedGroup
        targetPtyId={targetPtyId}
        terminalTabId="tab-card"
        ownsTabWideLaunchDraft={false}
      />
    </TooltipProvider>
  )
}

beforeEach(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
  composer.mounts = 0
  nativeChatPromptDismissals.clearForTests()
  ptyInput.verified.mockReset()
  useAppStore.setState({ agentStatusByPaneKey: {}, nativeChatLaunchPromptByTabId: {} })
  retained.session = transcript()
})

afterEach(() => {
  cleanup()
  restoreViewport()
  useAppStore.setState({ agentStatusByPaneKey: {}, nativeChatLaunchPromptByTabId: {} })
})

// Prompt cards own terminal input because composer sends would otherwise answer the agent’s active selector.
describe('NativeChatResolvedView prompt cards own the input region', () => {
  it('keeps an answered approval hidden across a chat view remount and a PTY rebind', async () => {
    ptyInput.verified.mockResolvedValue(true)
    setStatus({
      state: 'waiting',
      interactivePrompt: JSON.stringify({ approval: { tool: 'Bash', summary: 'npm test' } })
    })
    const first = renderPane()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    })
    // The approved tool is still running, so the host status lingers: a chat/terminal toggle.
    first.unmount()
    const second = renderPane()
    expect(document.querySelector('[data-native-chat-approval-card="true"]')).toBeNull()
    expect(screen.getByTestId('native-chat-composer').closest('[hidden]')).toBeNull()

    second.unmount()
    renderPane('pty-card-reconnected')
    expect(document.querySelector('[data-native-chat-approval-card="true"]')).toBeNull()
    expect(ptyInput.verified).toHaveBeenCalledOnce()
  })
})
