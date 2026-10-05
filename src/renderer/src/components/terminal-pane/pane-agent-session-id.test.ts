import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { TerminalConversationIdentity } from '../../../../shared/terminal-conversation-identity'
import type { HostLeafConversation, TerminalTab } from '../../../../shared/terminal-tab-types'
import { resolvePaneAgentSessionId, type PaneAgentSessionIdState } from './pane-agent-session-id'

const LEAF = '11111111-1111-4111-8111-111111111111'
const SIBLING_LEAF = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = `tab-1:${LEAF}`
const SIBLING_PANE_KEY = `tab-1:${SIBLING_LEAF}`

function state(
  live?: AgentStatusEntry,
  sleeping?: SleepingAgentSessionRecord,
  shellForeground = false,
  hostConversationByLeafId?: Record<string, HostLeafConversation>
): PaneAgentSessionIdState {
  return {
    agentStatusByPaneKey: live ? { [PANE_KEY]: live } : {},
    sleepingAgentSessionsByPaneKey: sleeping ? { [PANE_KEY]: sleeping } : {},
    paneForegroundAgentByPaneKey: { [PANE_KEY]: { agent: 'claude', shellForeground } },
    tabsByWorktree: hostConversationByLeafId
      ? { 'wt-1': [mirroredTab(hostConversationByLeafId)] }
      : {}
  }
}

function mirroredTab(hostConversationByLeafId: Record<string, HostLeafConversation>): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Say hi | my-repo',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    hostConversationByLeafId
  }
}

function identity(id: string): TerminalConversationIdentity {
  return {
    agentType: 'claude',
    providerSession: { key: 'session_id', id },
    capturedAt: 10,
    source: 'live'
  }
}

function offered(id: string): HostLeafConversation {
  return { identity: identity(id), offeredWithoutStatus: true }
}

function live(sessionId?: string, restoredUnconfirmed = false): AgentStatusEntry {
  return {
    state: 'done',
    prompt: '',
    updatedAt: 2,
    stateStartedAt: 2,
    paneKey: PANE_KEY,
    agentType: 'claude',
    stateHistory: [],
    ...(sessionId ? { providerSession: { key: 'session_id', id: sessionId } } : {}),
    ...(restoredUnconfirmed ? { restoredUnconfirmed: true } : {})
  }
}

function sleeping(sessionId: string): SleepingAgentSessionRecord {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'worktree-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: sessionId },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'live'
  }
}

describe('resolvePaneAgentSessionId', () => {
  it('returns the live provider session for the exact pane', () => {
    expect(resolvePaneAgentSessionId(state(live('live-session')), PANE_KEY)).toBe('live-session')
  })

  it('returns the pane-owned durable session after its live status row is cleared', () => {
    expect(
      resolvePaneAgentSessionId(state(undefined, sleeping('sleeping-session')), PANE_KEY)
    ).toBe('sleeping-session')
  })

  it('does not reuse an older durable session while a newer live row lacks identity', () => {
    expect(resolvePaneAgentSessionId(state(live(), sleeping('old-session')), PANE_KEY)).toBeNull()
  })

  it('falls back from an unconfirmed restored row to durable pane identity', () => {
    expect(
      resolvePaneAgentSessionId(
        state(live('unconfirmed-session', true), sleeping('confirmed-session')),
        PANE_KEY
      )
    ).toBe('confirmed-session')
  })

  describe('liveness', () => {
    it('is absent once the pane is proven back at the shell', () => {
      expect(
        resolvePaneAgentSessionId(state(live('live-session'), undefined, true), PANE_KEY)
      ).toBe(null)
    })

    it('is absent at the shell even when a durable record survives the exit', () => {
      expect(
        resolvePaneAgentSessionId(state(undefined, sleeping('sleeping-session'), true), PANE_KEY)
      ).toBeNull()
    })

    it('keeps a session whose foreground evidence is only that an agent runs', () => {
      expect(
        resolvePaneAgentSessionId(state(live('live-session'), undefined, false), PANE_KEY)
      ).toBe('live-session')
    })

    it('keeps a session for a pane with no foreground evidence at all', () => {
      expect(
        resolvePaneAgentSessionId(
          {
            agentStatusByPaneKey: { [PANE_KEY]: live('live-session') },
            sleepingAgentSessionsByPaneKey: {},
            paneForegroundAgentByPaneKey: {},
            tabsByWorktree: {}
          },
          PANE_KEY
        )
      ).toBe('live-session')
    })
  })

  it('does not read identity from a sibling pane', () => {
    const sibling = 'tab-1:22222222-2222-4222-8222-222222222222'
    expect(resolvePaneAgentSessionId(state(undefined, sleeping('session-1')), sibling)).toBeNull()
  })

  describe('a paired host conversation for this exact leaf', () => {
    it('copies the mirrored session on a cold statusless pane with no sleeping record', () => {
      expect(
        resolvePaneAgentSessionId(
          state(undefined, undefined, false, { [LEAF]: offered('S') }),
          PANE_KEY
        )
      ).toBe('S')
    })

    it('copies each split leaf its own session and never a sibling one', () => {
      const split = state(undefined, undefined, false, {
        [LEAF]: offered('S'),
        [SIBLING_LEAF]: offered('T')
      })
      expect(resolvePaneAgentSessionId(split, PANE_KEY)).toBe('S')
      expect(resolvePaneAgentSessionId(split, SIBLING_PANE_KEY)).toBe('T')
      const onlySibling = state(undefined, undefined, false, { [SIBLING_LEAF]: offered('T') })
      expect(resolvePaneAgentSessionId(onlySibling, PANE_KEY)).toBeNull()
    })

    it("keeps the sleeping-record read when the host withholds this leaf's field", () => {
      expect(
        resolvePaneAgentSessionId(
          state(undefined, sleeping('R'), false, { [SIBLING_LEAF]: offered('T') }),
          PANE_KEY
        )
      ).toBe('R')
    })

    it("keeps today's sleeping-record read for an old host that sent no field", () => {
      expect(resolvePaneAgentSessionId(state(undefined, sleeping('R'), false, {}), PANE_KEY)).toBe(
        'R'
      )
    })

    it('copies nothing once the shell is back in front, whatever the host holds', () => {
      expect(
        resolvePaneAgentSessionId(
          state(undefined, undefined, true, { [LEAF]: offered('S') }),
          PANE_KEY
        )
      ).toBeNull()
    })

    it('copies the field session beside a status that lost its address in the prompt window', () => {
      expect(
        resolvePaneAgentSessionId(
          state(live(), undefined, false, {
            [LEAF]: { identity: identity('S'), offeredWithoutStatus: false }
          }),
          PANE_KEY
        )
      ).toBe('S')
    })

    it('copies nothing from a statusless field the host did not offer', () => {
      expect(
        resolvePaneAgentSessionId(
          state(undefined, undefined, false, {
            [LEAF]: { identity: identity('S'), offeredWithoutStatus: false }
          }),
          PANE_KEY
        )
      ).toBeNull()
    })
  })
})
