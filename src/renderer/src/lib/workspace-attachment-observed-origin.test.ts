import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { makeTerminalTab } from '../store/slices/worktrees-slice-test-fixtures'
import { singlePaneLayoutSnapshot } from '../store/slices/terminal-helpers'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  getWorkspaceAttachmentObservedOrigin,
  getWorkspaceAttachmentTerminalOrigin
} from './workspace-attachment-observed-origin'

const workspaceId = 'repo::/feature'
const leaf = '11111111-1111-4111-8111-111111111111'
const otherLeaf = '22222222-2222-4222-8222-222222222222'
const context = { tabId: 'tab', paneKey: makePaneKey('tab', leaf), ptyId: 'pty' }
function state(): Pick<
  AppState,
  'tabsByWorktree' | 'terminalLayoutsByTabId' | 'agentStatusByPaneKey'
> {
  return {
    tabsByWorktree: {
      [workspaceId]: [makeTerminalTab({ id: 'tab', worktreeId: workspaceId, ptyId: 'pty' })]
    },
    terminalLayoutsByTabId: { tab: singlePaneLayoutSnapshot(leaf, 'pty') },
    agentStatusByPaneKey: {
      [context.paneKey]: {
        state: 'working',
        prompt: '',
        updatedAt: 1,
        stateStartedAt: 1,
        paneKey: context.paneKey,
        stateHistory: [],
        worktreeId: workspaceId,
        terminalHandle: 'pty',
        agentType: 'codex',
        providerSession: { id: 'provider-session', key: 'session_id' }
      }
    }
  }
}
describe('reference evidence terminal identity', () => {
  it('records the currently bound provider session', () => {
    expect(getWorkspaceAttachmentTerminalOrigin(state(), workspaceId, context, 'local')).toEqual(
      expect.objectContaining({
        tabId: 'tab',
        paneKey: context.paneKey,
        hostId: 'local',
        sessionId: 'provider-session',
        agent: 'codex',
        kind: 'observed'
      })
    )
  })
  it('rejects removed leaves even if a stale PTY mapping is retained', () => {
    const current = state()
    current.terminalLayoutsByTabId.tab = {
      ...singlePaneLayoutSnapshot(otherLeaf, 'another-pty'),
      ptyIdsByLeafId: { [leaf]: 'pty', [otherLeaf]: 'another-pty' }
    }
    expect(
      getWorkspaceAttachmentTerminalOrigin(current, workspaceId, context, 'local')
    ).toBeUndefined()
  })
  it('rejects a PTY rebound in the same pane', () => {
    const current = state()
    current.terminalLayoutsByTabId.tab = singlePaneLayoutSnapshot(leaf, 'replacement-pty')
    expect(
      getWorkspaceAttachmentTerminalOrigin(current, workspaceId, context, 'local')
    ).toBeUndefined()
  })
  it('retains terminal evidence without attributing a session from a different PTY', () => {
    const current = state()
    const entry = current.agentStatusByPaneKey[context.paneKey]
    if (!entry) {
      throw new Error('Expected source session')
    }
    entry.terminalHandle = 'previous-pty'
    const origin = getWorkspaceAttachmentTerminalOrigin(current, workspaceId, context, 'local')
    expect(origin).toMatchObject({ tabId: 'tab', kind: 'observed' })
    expect(origin?.sessionId).toBeUndefined()
    expect(origin?.agent).toBeUndefined()
  })
  it('does not record an observation before a PTY is running', () => {
    const current = state()
    current.terminalLayoutsByTabId.tab = singlePaneLayoutSnapshot(leaf)
    current.tabsByWorktree[workspaceId][0].ptyId = null
    current.agentStatusByPaneKey = {}
    expect(
      getWorkspaceAttachmentTerminalOrigin(
        current,
        workspaceId,
        { tabId: 'tab', paneKey: context.paneKey },
        'local'
      )
    ).toBeUndefined()
  })
})

describe('reference evidence native chat identity', () => {
  it('records the chat tab and its session without a terminal pane', () => {
    const chat = {
      ...state(),
      unifiedTabsByWorktree: {
        [workspaceId]: [
          {
            id: 'chat-tab',
            entityId: 'chat-session',
            groupId: 'group',
            worktreeId: workspaceId,
            contentType: 'agent-session' as const,
            agentSessionAgent: 'claude' as const,
            label: 'Plan refactor',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      }
    }
    expect(
      getWorkspaceAttachmentObservedOrigin(
        chat,
        workspaceId,
        { kind: 'agent-session', tabId: 'chat-tab' },
        'local'
      )
    ).toEqual({
      kind: 'observed',
      tabId: 'chat-tab',
      hostId: 'local',
      label: 'Plan refactor',
      agent: 'claude',
      sessionId: 'chat-session'
    })
  })
})
