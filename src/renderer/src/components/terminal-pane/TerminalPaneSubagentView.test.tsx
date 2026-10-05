// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { TerminalPaneController } from './use-terminal-pane-controller'

const sessionArgs = vi.hoisted<{ calls: Record<string, unknown>[] }>(() => ({ calls: [] }))

vi.mock('../native-chat/use-native-chat-retained-session', () => ({
  useNativeChatRetainedSession: (args: Record<string, unknown>) => {
    sessionArgs.calls.push(args)
    return {
      messages: [{ id: 'm1', role: 'user', blocks: [], timestamp: 1, source: 'transcript' }],
      status: 'ready',
      sessionId: args.sessionId,
      agent: 'claude',
      readPhase: 'ready'
    }
  }
}))
const listProps = vi.hoisted<{ last: Record<string, unknown> | null }>(() => ({ last: null }))
const linkActions = vi.hoisted<{
  onLinkClick: () => void
  closeLinkActions: () => void
  scopes: unknown[]
}>(() => ({ onLinkClick: () => {}, closeLinkActions: () => {}, scopes: [] }))

vi.mock('../native-chat/NativeChatMessageList', () => ({
  NativeChatMessageList: (props: Record<string, unknown>) => {
    listProps.last = props
    return <div data-testid="subagent-transcript" />
  }
}))
vi.mock('../native-chat/use-native-chat-file-link-context', () => ({
  useNativeChatFileLinkContext: () => ({ worktreeId: 'wt-1' })
}))
vi.mock('../native-chat/use-native-chat-link-actions', () => ({
  useNativeChatLinkActions: (_context: unknown, _rootRef: unknown, scope: unknown) => {
    linkActions.scopes.push(scope)
    return {
      onLinkClick: linkActions.onLinkClick,
      linkActionRequest: null,
      closeLinkActions: linkActions.closeLinkActions
    }
  }
}))
vi.mock('./NativeChatPaneCover', () => ({
  NativeChatPaneCover: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))
vi.mock('./pane-subagent-view-source', () => ({
  paneShownSubagentTranscriptPath: (
    state: { paneSubagentViewByPaneKey: Record<string, { agentId: string }> },
    paneKey: string
  ) => {
    const view = state.paneSubagentViewByPaneKey[paneKey]
    return view ? `/p/693d/subagents/agent-${view.agentId}.jsonl` : null
  }
}))

import { TerminalPaneSubagentViewPortals } from './TerminalPaneSubagentView'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF}`

function renderPortals(): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the portals read only managedPanes, tabId and isRendererVisible.
  const controller = {
    managedPanes: [{ id: 1, leafId: LEAF, container }],
    tabId: 'tab-1',
    isRendererVisible: true
  } as unknown as TerminalPaneController
  render(<TerminalPaneSubagentViewPortals controller={controller} />)
  return container
}

describe('TerminalPaneSubagentViewPortals', () => {
  beforeEach(() => {
    sessionArgs.calls = []
    listProps.last = null
    linkActions.scopes = []
    useAppStore.setState({
      paneSubagentViewByPaneKey: {},
      agentStatusByPaneKey: {
        [PANE_KEY]: {
          paneKey: PANE_KEY,
          state: 'working',
          prompt: 'Parent',
          updatedAt: 100,
          stateStartedAt: 10,
          stateHistory: [],
          agentType: 'claude',
          providerSession: { key: 'session_id', id: 's1', transcriptPath: '/p/693d.jsonl' },
          subagents: [
            { id: 'a1', state: 'working', description: 'Explore battle scripts', startedAt: 20 },
            { id: 'a2', state: 'working', description: 'Explore page scripts', startedAt: 21 }
          ]
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('leaves the pane uncovered while it shows its main agent', () => {
    renderPortals()
    expect(screen.queryByTestId('subagent-transcript')).toBeNull()
  })

  it("covers the pane with the chosen subagent's transcript, not the parent's", () => {
    useAppStore
      .getState()
      .showPaneSubagent(PANE_KEY, { agentId: 'a1', name: 'Explore battle scripts' })
    const pane = renderPortals()

    expect(pane.querySelector('[data-testid="subagent-transcript"]')).not.toBeNull()
    expect(sessionArgs.calls.at(-1)).toMatchObject({
      agent: 'claude',
      sessionId: 'a1',
      transcriptPath: '/p/693d/subagents/agent-a1.jsonl'
    })
    expect(sessionArgs.calls.at(-1)?.paneKey).not.toBe(PANE_KEY)
  })

  it('opens links in the subagent transcript the way the pane chat does', () => {
    useAppStore
      .getState()
      .showPaneSubagent(PANE_KEY, { agentId: 'a1', name: 'Explore battle scripts' })
    renderPortals()

    expect(listProps.last).toMatchObject({
      onLinkClick: linkActions.onLinkClick,
      allowFileUriLinks: true
    })
    // Scoped to the subagent, so switching subagents dismisses an open link menu.
    expect(linkActions.scopes.at(-1)).toEqual({ sessionId: 'a1', isVisible: true })
  })

  it('switches between the main agent and each running subagent explicitly', () => {
    useAppStore
      .getState()
      .showPaneSubagent(PANE_KEY, { agentId: 'a1', name: 'Explore battle scripts' })
    renderPortals()

    fireEvent.click(screen.getByRole('radio', { name: 'Explore page scripts' }))
    expect(useAppStore.getState().paneSubagentViewByPaneKey[PANE_KEY]).toEqual({
      agentId: 'a2',
      name: 'Explore page scripts',
      parentTranscriptPath: '/p/693d.jsonl'
    })

    // Clicking the shown subagent again keeps it shown.
    fireEvent.click(screen.getByRole('radio', { name: 'Explore page scripts' }))
    expect(useAppStore.getState().paneSubagentViewByPaneKey[PANE_KEY]?.agentId).toBe('a2')

    fireEvent.click(screen.getByRole('radio', { name: 'Main agent' }))
    expect(useAppStore.getState().paneSubagentViewByPaneKey[PANE_KEY]).toBeUndefined()
    expect(screen.queryByTestId('subagent-transcript')).toBeNull()
  })

  it('keeps a finished subagent choosable after it leaves the running list', () => {
    useAppStore.getState().showPaneSubagent(PANE_KEY, { agentId: 'gone', name: 'Finished explore' })
    renderPortals()
    expect(screen.getByRole('radio', { name: 'Finished explore' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Explore battle scripts' })).toBeTruthy()
  })
})
