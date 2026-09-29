// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'

const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
const claim = {
  worktreeId: 'wt-1',
  launchAgent: 'codex' as const,
  providerSession: { key: 'session_id' as const, id: 'resumed-codex' }
}
let hookEntry: AgentStatusEntry | undefined
const state = {
  automaticAgentResumeClaimsByTabId: { 'tab-1': claim },
  paneForegroundAgentByPaneKey: {
    [paneKey]: { agent: 'codex' as const, shellForeground: false }
  }
}

vi.mock('../../store', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state)
}))
vi.mock('./use-native-chat-status-entry', () => ({
  useNativeChatStatusEntry: () => ({ entry: hookEntry, paneKey })
}))
vi.mock('./NativeChatResolvedView', () => ({
  NativeChatResolvedView: ({ sessionId }: { sessionId: string | null }) => (
    <div>Session {sessionId ?? 'none'}</div>
  )
}))
vi.mock('./NativeChatPaneFileDropSurface', () => ({
  NativeChatPaneFileDropSurface: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))
vi.mock('./NativeChatStructuredSession', () => ({ NativeChatStructuredSession: () => null }))

import NativeChatView from './NativeChatView'

afterEach(() => {
  cleanup()
  hookEntry = undefined
  state.paneForegroundAgentByPaneKey[paneKey].shellForeground = false
})

it('shows the resumed Codex transcript identity before hooks report, then prefers the hook', () => {
  const props = {
    terminalTabId: 'tab-1',
    paneKey,
    launchAgent: 'codex' as const,
    isVisible: true,
    isFocusedGroup: true,
    ownsTabWideLaunchDraft: true
  }
  const view = render(<NativeChatView {...props} />)
  expect(screen.getByText('Session resumed-codex')).toBeInTheDocument()

  hookEntry = {
    paneKey,
    agentType: 'codex',
    providerSession: { key: 'session_id', id: 'hook-codex' },
    state: 'done',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: []
  }
  view.rerender(<NativeChatView {...props} />)
  expect(screen.getByText('Session hook-codex')).toBeInTheDocument()
})

it('keeps a tab-wide resume claim off a split sibling and a pane back at the shell', () => {
  const props = {
    terminalTabId: 'tab-1',
    paneKey,
    launchAgent: 'codex' as const,
    isVisible: true,
    isFocusedGroup: true,
    ownsTabWideLaunchDraft: false
  }
  const view = render(<NativeChatView {...props} />)
  expect(screen.getByText('Session none')).toBeInTheDocument()

  state.paneForegroundAgentByPaneKey[paneKey].shellForeground = true
  view.rerender(<NativeChatView {...props} ownsTabWideLaunchDraft />)
  expect(screen.getByText('Session none')).toBeInTheDocument()
})
