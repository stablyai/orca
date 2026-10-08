import { describe, expect, it, vi } from 'vitest'
import { resolveAutoAckTabTargets } from './useAutoAckViewedAgent'
import { acknowledgeViewedAutoAckTarget } from './agent-auto-ack-surfaces'
import {
  createTestStore,
  makeTab,
  makeTabGroup,
  makeUnifiedTab
} from '../store/slices/store-test-helpers'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { structuredAgentSessionPaneKey } from '../../../shared/structured-agent-session-projection'

const WORKSPACE = 'wt-1'
const GROUP = 'group-1'
const TERMINAL_TAB = 'term-tab'
const LEAF = '11111111-1111-4111-8111-111111111111'
const TERMINAL_SUBJECT = makePaneKey(TERMINAL_TAB, LEAF)
const CHAT_TAB = 'chat-tab'
const SESSION = 'session-1'
const CHAT_SUBJECT = structuredAgentSessionPaneKey(CHAT_TAB, SESSION)

type TestStore = ReturnType<typeof createTestStore>

/**
 * One workspace holding a terminal pane and a structured chat in the same layout group, with the
 * caller choosing which of the two the group is showing. `activeTabId` stays on the terminal in
 * both cases because it is terminal-only state that a chat activation never moves.
 */
function seedMixedWorkspace(seed: {
  visible: 'terminal' | 'chat'
  unreadSubjectKeys: readonly string[]
}): { store: TestStore; clearWorktreeUnread: ReturnType<typeof vi.fn> } {
  const store = createTestStore()
  const clearWorktreeUnread = vi.fn()
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
    ),
    // Observed instead of run: the real action persists worktree metadata through the host.
    clearWorktreeUnread
  })
  return { store, clearWorktreeUnread }
}

/** The hook's scan loop: resolve what is on screen, then acknowledge each target in turn. */
function runAutoAckScan(store: TestStore): void {
  for (const target of resolveAutoAckTabTargets(store.getState())) {
    acknowledgeViewedAutoAckTarget(store.getState(), target)
  }
}

describe('auto-ack in a workspace holding both a terminal and a structured chat', () => {
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

  it('acknowledging the visible terminal keeps the hidden chat unread', () => {
    const { store, clearWorktreeUnread } = seedMixedWorkspace({
      visible: 'terminal',
      unreadSubjectKeys: [TERMINAL_SUBJECT, CHAT_SUBJECT]
    })

    runAutoAckScan(store)

    expect(store.getState().unreadAgentCompletionPanes[TERMINAL_SUBJECT]).toBeUndefined()
    expect(store.getState().unreadAgentCompletionPanes[CHAT_SUBJECT]).toBe('agent-completion')
    expect(clearWorktreeUnread).not.toHaveBeenCalled()
  })

  it('acknowledging the visible chat keeps the hidden terminal unread', () => {
    const { store, clearWorktreeUnread } = seedMixedWorkspace({
      visible: 'chat',
      unreadSubjectKeys: [TERMINAL_SUBJECT, CHAT_SUBJECT]
    })

    runAutoAckScan(store)

    expect(store.getState().unreadAgentCompletionPanes[CHAT_SUBJECT]).toBeUndefined()
    expect(store.getState().unreadAgentCompletionPanes[TERMINAL_SUBJECT]).toBe('agent-completion')
    expect(clearWorktreeUnread).not.toHaveBeenCalled()
  })

  it('clears workspace attention when the visible terminal held the only unread', () => {
    const { store, clearWorktreeUnread } = seedMixedWorkspace({
      visible: 'terminal',
      unreadSubjectKeys: [TERMINAL_SUBJECT]
    })

    runAutoAckScan(store)

    expect(clearWorktreeUnread).toHaveBeenCalledWith(WORKSPACE)
  })

  it('clears workspace attention when the visible chat held the only unread', () => {
    const { store, clearWorktreeUnread } = seedMixedWorkspace({
      visible: 'chat',
      unreadSubjectKeys: [CHAT_SUBJECT]
    })

    runAutoAckScan(store)

    expect(clearWorktreeUnread).toHaveBeenCalledWith(WORKSPACE)
  })

  it('keeps workspace attention while a hidden chat holds only container unread', () => {
    const { store, clearWorktreeUnread } = seedMixedWorkspace({
      visible: 'terminal',
      unreadSubjectKeys: [TERMINAL_SUBJECT]
    })
    store.getState().markTerminalTabUnread(CHAT_TAB, 'agent-completion')

    runAutoAckScan(store)

    expect(store.getState().unreadTerminalTabs[CHAT_TAB]).toBe('agent-completion')
    expect(clearWorktreeUnread).not.toHaveBeenCalled()
  })
})

describe('markTerminalTabUnread container addressing', () => {
  it('accepts a structured chat addressed by its unified tab id', () => {
    const { store } = seedMixedWorkspace({ visible: 'chat', unreadSubjectKeys: [] })

    store.getState().markTerminalTabUnread(CHAT_TAB, 'agent-completion')

    expect(store.getState().unreadTerminalTabs[CHAT_TAB]).toBe('agent-completion')
  })

  it('still refuses an id no open tab owns', () => {
    const { store } = seedMixedWorkspace({ visible: 'chat', unreadSubjectKeys: [] })

    store.getState().markTerminalTabUnread('tab-that-never-existed', 'agent-completion')

    expect(store.getState().unreadTerminalTabs['tab-that-never-existed']).toBeUndefined()
  })
})
