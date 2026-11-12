// @vitest-environment happy-dom

import { act, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserPage } from '../../../../../../shared/browser-workspace-types'
import { setBrowserAgentPageActive } from '../../../browser-pane/agent-cursor/browser-agent-activity-state'
import {
  NativeChatVisualOwnerContext,
  type NativeChatVisualOwner
} from '../../media/visuals/native-chat-visual-owner'
import { NativeChatBrowserRunPageButton } from './NativeChatBrowserPageButton'

function page(id: string, title: string): BrowserPage {
  return {
    id,
    workspaceId: 'ws-1',
    worktreeId: 'wt-1',
    url: `https://example.com/${id}`,
    title,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

const state = vi.hoisted((): { browserPagesByWorkspace: Record<string, BrowserPage[]> } => ({
  browserPagesByWorkspace: {}
}))
vi.mock('@/store', () => ({
  useAppStore: (select: (current: typeof state) => unknown) => select(state)
}))

const OWNER: NativeChatVisualOwner = {
  target: { kind: 'local' },
  sessionId: 'session-1',
  worktreeId: 'wt-1'
}

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <NativeChatVisualOwnerContext.Provider value={OWNER}>
      {children}
    </NativeChatVisualOwnerContext.Provider>
  )
}

describe('NativeChatBrowserRunPageButton', () => {
  it('keeps the page a run drove after the agent moves to a newer page', () => {
    state.browserPagesByWorkspace = { 'ws-1': [page('p1', 'First'), page('p2', 'Second')] }
    render(
      <NativeChatBrowserRunPageButton
        calls={[
          {
            type: 'tool-call',
            name: 'Bash',
            input: { command: 'orca browser snapshot' },
            callId: 'run-a'
          }
        ]}
      />,
      { wrapper }
    )

    act(() => setBrowserAgentPageActive('p1', true, 'wt-1'))
    expect(screen.getByRole('button').getAttribute('title')).toBe('First')

    act(() => setBrowserAgentPageActive('p2', true, 'wt-1'))
    expect(screen.getByRole('button').getAttribute('title')).toBe('First')
  })

  it("ignores other agents driving a different page before this run's command lands", () => {
    state.browserPagesByWorkspace = { 'ws-1': [page('p1', 'Mine'), page('p2', 'Theirs')] }
    // An earlier run in this chat, so it is known to claim its activity.
    setBrowserAgentPageActive('p1', true, 'wt-1', undefined, 'session-1')
    const { container } = render(
      <NativeChatBrowserRunPageButton
        calls={[
          {
            type: 'tool-call',
            name: 'Bash',
            input: { command: 'orca browser click @e1' },
            callId: 'run-b'
          }
        ]}
      />,
      { wrapper }
    )

    act(() => setBrowserAgentPageActive('p2', true, 'wt-1'))
    act(() => setBrowserAgentPageActive('p2', true, 'wt-1', undefined, 'session-2'))
    act(() => setBrowserAgentPageActive('p1', true, 'wt-1', undefined, 'session-1'))
    act(() => setBrowserAgentPageActive('p2', true, 'wt-1'))
    expect(within(container).getByRole('button').getAttribute('title')).toBe('Mine')
  })
})
