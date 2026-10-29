import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { resolveAutoAckTabTargets } from './agent-auto-ack-targets'
import { acknowledgeViewedAutoAckTarget } from './agent-auto-ack-surfaces'
import {
  createTestStore,
  makeTab,
  makeTabGroup,
  makeUnifiedTab
} from '../store/slices/store-test-helpers'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { structuredAgentSessionPaneKey } from '../../../shared/structured-agent-session-projection'
import { workspaceHasLiveMarker } from '../store/slices/workspace-attention/workspace-live-markers'

const WORKSPACE = 'wt-1'
const GROUP = 'group-1'
const TERMINAL_TAB = 'term-tab'
const LEAF = '11111111-1111-4111-8111-111111111111'
const TERMINAL_SUBJECT = makePaneKey(TERMINAL_TAB, LEAF)
const CHAT_TAB = 'chat-tab'
const SESSION = 'session-1'
const CHAT_SUBJECT = structuredAgentSessionPaneKey(CHAT_TAB, SESSION)

type TestStore = ReturnType<typeof createTestStore>

/** Choose terminal/chat visibility within one group while legacy activeTabId still names the terminal in either case. */
function seedMixedWorkspace(seed: {
  visible: 'terminal' | 'chat'
  unreadSubjectKeys: readonly string[]
}): { store: TestStore } {
  const store = createTestStore()
  store.setState({
    activeView: 'terminal',
    activeWorktreeId: WORKSPACE,
    activeTabId: TERMINAL_TAB,
    activeTabIdByWorktree: { [WORKSPACE]: TERMINAL_TAB },
    tabsByWorktree: { [WORKSPACE]: [makeTab({ id: TERMINAL_TAB, worktreeId: WORKSPACE })] },
    ptyIdsByTabId: { [TERMINAL_TAB]: ['pty-1'] },
    terminalLayoutsByTabId: {
      [TERMINAL_TAB]: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: 'pty-1' }
      }
    },
    unifiedTabsByWorktree: {
      [WORKSPACE]: [
        makeUnifiedTab({ id: TERMINAL_TAB, worktreeId: WORKSPACE, groupId: GROUP }),
        makeUnifiedTab({
          id: CHAT_TAB,
          worktreeId: WORKSPACE,
          groupId: GROUP,
          contentType: 'agent-session',
          entityId: SESSION,
          agentSessionAgent: 'claude'
        })
      ]
    },
    groupsByWorktree: {
      [WORKSPACE]: [
        makeTabGroup({
          id: GROUP,
          worktreeId: WORKSPACE,
          activeTabId: seed.visible === 'chat' ? CHAT_TAB : TERMINAL_TAB,
          tabOrder: [TERMINAL_TAB, CHAT_TAB]
        })
      ]
    },
    activeGroupIdByWorktree: { [WORKSPACE]: GROUP },
    unreadAgentCompletionPanes: Object.fromEntries(
      seed.unreadSubjectKeys.map((key) => [key, 'agent-completion'])
    )
  })
  return { store }
}

function runAutoAckScan(store: TestStore): void {
  const targets = resolveAutoAckTabTargets(store.getState())
  for (const target of targets) {
    acknowledgeViewedAutoAckTarget(store.getState(), target)
  }
  store
    .getState()
    .readOnScreenAttention({ workspaceIds: [WORKSPACE], targets }, { screenArrived: true })
}

const workspaceStillHeld = (store: TestStore): boolean =>
  workspaceHasLiveMarker(store.getState(), WORKSPACE)

describe('the on-screen read in a workspace holding both a terminal and a structured chat', () => {
  it('sends the visible surface to the adapter that owns its address', () => {
    expect(
      resolveAutoAckTabTargets(
        seedMixedWorkspace({ visible: 'terminal', unreadSubjectKeys: [] }).store.getState()
      )
    ).toEqual([{ tabId: TERMINAL_TAB, worktreeId: WORKSPACE, surfaceKind: 'terminal' }])

    expect(
      resolveAutoAckTabTargets(
        seedMixedWorkspace({ visible: 'chat', unreadSubjectKeys: [] }).store.getState()
      )
    ).toEqual([{ tabId: CHAT_TAB, worktreeId: WORKSPACE, surfaceKind: 'structured' }])
  })

  it('reading the visible terminal keeps the hidden chat unread', () => {
    const { store } = seedMixedWorkspace({
      visible: 'terminal',
      unreadSubjectKeys: [TERMINAL_SUBJECT, CHAT_SUBJECT]
    })

    runAutoAckScan(store)

    expect(store.getState().unreadAgentCompletionPanes[TERMINAL_SUBJECT]).toBeUndefined()
    expect(store.getState().unreadAgentCompletionPanes[CHAT_SUBJECT]).toBe('agent-completion')
    expect(workspaceStillHeld(store)).toBe(true)
  })

  it('reading the visible chat keeps the hidden terminal unread', () => {
    const { store } = seedMixedWorkspace({
      visible: 'chat',
      unreadSubjectKeys: [TERMINAL_SUBJECT, CHAT_SUBJECT]
    })

    runAutoAckScan(store)

    expect(store.getState().unreadAgentCompletionPanes[CHAT_SUBJECT]).toBeUndefined()
    expect(store.getState().unreadAgentCompletionPanes[TERMINAL_SUBJECT]).toBe('agent-completion')
    expect(workspaceStillHeld(store)).toBe(true)
  })

  it('clears workspace attention when the visible terminal held the only unread', () => {
    const { store } = seedMixedWorkspace({
      visible: 'terminal',
      unreadSubjectKeys: [TERMINAL_SUBJECT]
    })

    runAutoAckScan(store)

    expect(workspaceStillHeld(store)).toBe(false)
  })

  it('clears workspace attention when the visible chat held the only unread', () => {
    const { store } = seedMixedWorkspace({
      visible: 'chat',
      unreadSubjectKeys: [CHAT_SUBJECT]
    })

    runAutoAckScan(store)

    expect(workspaceStillHeld(store)).toBe(false)
  })

  it('keeps workspace attention while a hidden chat holds only its tab marker', () => {
    const { store } = seedMixedWorkspace({
      visible: 'terminal',
      unreadSubjectKeys: [TERMINAL_SUBJECT]
    })
    store.setState({ unreadTerminalTabs: { [CHAT_TAB]: 'agent-completion' } })

    runAutoAckScan(store)

    expect(store.getState().unreadTerminalTabs[CHAT_TAB]).toBe('agent-completion')
    expect(workspaceStillHeld(store)).toBe(true)
  })
})

function markChatGroupUnread(store: TestStore, groupId: string): void {
  // Why: tab markers for completions sit behind the experimental attention setting.
  store.setState({
    settings: { ...getDefaultSettings('/home/test'), experimentalTerminalAttention: true }
  })
  store.getState().markAgentAttentionUnread({
    workspaceId: WORKSPACE,
    subjectKey: CHAT_SUBJECT,
    groupId,
    reason: 'agent-completion'
  })
}

describe('tab marker container addressing', () => {
  it('accepts a structured chat addressed by its unified tab id', () => {
    const { store } = seedMixedWorkspace({ visible: 'chat', unreadSubjectKeys: [] })

    markChatGroupUnread(store, CHAT_TAB)

    expect(store.getState().unreadTerminalTabs[CHAT_TAB]).toBe('agent-completion')
  })

  it('still refuses an id no open tab owns', () => {
    const { store } = seedMixedWorkspace({ visible: 'chat', unreadSubjectKeys: [] })

    markChatGroupUnread(store, 'tab-that-never-existed')

    expect(store.getState().unreadTerminalTabs['tab-that-never-existed']).toBeUndefined()
  })
})
