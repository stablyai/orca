// The keyed attention reader (STA-18283) must always agree with reading every watched workspace.
import { expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { structuredAgentSessionPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import { makeBrowserTab } from '@/store/slices/browser/browser-tab.test-fixture'
import { makeStructuredChatTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { createWatchedAttentionReader, workspaceHasAttention } from './bot-sidebar-attention'

function report(paneKey: string, tabId: string, worktreeId: string, state: 'working' | 'done') {
  useAppStore
    .getState()
    .setAgentStatus(paneKey, { state, prompt: 'go', agentType: 'claude' }, 'Claude', undefined, {
      tabId,
      worktreeId
    })
}

it('agrees with a full read after every kind of write', () => {
  const ids = ['wt-0', 'wt-1', 'wt-2', 'wt-3', 'wt-4']
  useAppStore.setState({
    tabsByWorktree: Object.fromEntries(
      [...ids, 'wt-x'].map((id) => [id, [makeTab({ id: `tab-${id}`, worktreeId: id })]])
    ),
    runtimePaneTitlesByTabId: {},
    ptyIdsByTabId: {}
  })
  const read = createWatchedAttentionReader()
  let watched = ids
  const expectFullRead = (): readonly string[] => {
    const state = useAppStore.getState()
    const answer = read(state, watched)
    expect(answer).toEqual(watched.filter((id) => workspaceHasAttention(state, id)))
    return answer
  }
  expectFullRead()

  report('tab-wt-1:1', 'tab-wt-1', 'wt-1', 'working')
  expect(expectFullRead()).toContain('wt-1')

  // An agent whose tab no workspace lists, attributed by the workspace it names.
  report('tab-ghost:1', 'tab-ghost', 'wt-2', 'working')
  expectFullRead()
  report('tab-ghost:1', 'tab-ghost', 'wt-2', 'done')
  expectFullRead()

  report('tab-wt-1:1', 'tab-wt-1', 'wt-1', 'done')
  expectFullRead()

  useAppStore.setState({ runtimePaneTitlesByTabId: { 'tab-wt-3': { 1: '⠋ Claude Code' } } })
  expectFullRead()
  useAppStore.setState({ ptyIdsByTabId: { 'tab-wt-3': ['pty-3'] } })
  expectFullRead()

  // The titled tab moves to another workspace.
  const tabs = useAppStore.getState().tabsByWorktree
  useAppStore.setState({
    tabsByWorktree: {
      ...tabs,
      'wt-3': [],
      'wt-4': [...tabs['wt-4']!, { ...tabs['wt-3']![0]!, worktreeId: 'wt-4' }]
    }
  })
  expectFullRead()

  report('tab-wt-x:1', 'tab-wt-x', 'wt-x', 'working')
  expectFullRead()
  watched = ['wt-x', 'wt-4', 'wt-1']
  expect(expectFullRead()).toContain('wt-x')

  useAppStore.setState({ wslHostStatuses: {} })
  expectFullRead()

  // An awake structured chat counts until its host answers that it sleeps.
  const chatTab = makeStructuredChatTab({ id: 'chat', entityId: 'session', worktreeId: 'wt-0' })
  watched = [...watched, 'wt-0']
  expectFullRead()
  useAppStore.setState({
    unifiedTabsByWorktree: { 'wt-0': [chatTab] }
  })
  expect(expectFullRead()).toContain('wt-0')
  useAppStore.setState({
    structuredChatSleptAtByPaneKey: { [structuredAgentSessionPaneKey('chat', 'session')]: 1 }
  })
  expect(expectFullRead()).not.toContain('wt-0')

  // A browser tab makes a workspace live.
  useAppStore.setState({
    browserTabsByWorktree: {
      'wt-0': [makeBrowserTab({ id: 'page', worktreeId: 'wt-0', url: 'https://example.com' })]
    }
  })
  expect(expectFullRead()).toContain('wt-0')
  useAppStore.setState({ browserTabsByWorktree: {} })
  expect(expectFullRead()).not.toContain('wt-0')
})
