import { beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  chatTabShowing,
  noteChatTabShowings,
  resetChatTabShowingsForTests
} from './chat-tab-showings'

const HOST = { kind: 'environment', environmentId: 'server-1' } as const

function snapshot(
  version: number,
  tabs: { sessionId: string; showing?: string }[],
  epoch = 'epoch-1'
): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'wt',
    publicationEpoch: epoch,
    snapshotVersion: version,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: tabs.map(({ sessionId, showing }) => ({
      type: 'agent-session',
      id: `tab-${sessionId}`,
      title: sessionId,
      sessionId,
      agent: 'claude',
      isActive: false,
      ...(showing ? { showing } : {})
    }))
  }
}

beforeEach(() => {
  resetChatTabShowingsForTests()
})

describe("a chat tab's showing", () => {
  it('is gone once a snapshot shows the tab with none, or not at all', () => {
    noteChatTabShowings(
      snapshot(1, [
        { sessionId: 'a', showing: 'old-a' },
        { sessionId: 'b', showing: 'old-b' }
      ]),
      HOST
    )
    expect(chatTabShowing(HOST, 'wt', 'a')).toBe('old-a')

    // A replacement tab with no name (an older host path) and a tab that closed.
    noteChatTabShowings(snapshot(2, [{ sessionId: 'a' }]), HOST)
    expect(chatTabShowing(HOST, 'wt', 'a')).toBeNull()
    expect(chatTabShowing(HOST, 'wt', 'b')).toBeNull()
  })

  it('takes the newest snapshot of a publication, and a new publication whatever its version', () => {
    noteChatTabShowings(snapshot(5, [{ sessionId: 'a', showing: 'new' }]), HOST)
    noteChatTabShowings(snapshot(4, [{ sessionId: 'a', showing: 'stale' }]), HOST)
    expect(chatTabShowing(HOST, 'wt', 'a')).toBe('new')

    noteChatTabShowings(
      snapshot(1, [{ sessionId: 'a', showing: 'after-restart' }], 'epoch-2'),
      HOST
    )
    expect(chatTabShowing(HOST, 'wt', 'a')).toBe('after-restart')
  })

  it('keeps each host apart', () => {
    noteChatTabShowings(snapshot(1, [{ sessionId: 'a', showing: 'there' }]), HOST)
    expect(chatTabShowing({ kind: 'local' }, 'wt', 'a')).toBeNull()
  })

  it('names nothing for a host that never sends names, so its chats keep the plain close', () => {
    const older = { kind: 'environment', environmentId: 'older-server' } as const
    noteChatTabShowings(snapshot(1, [{ sessionId: 'a' }, { sessionId: 'b' }]), older)
    noteChatTabShowings(snapshot(2, [{ sessionId: 'a' }]), older)
    expect(chatTabShowing(older, 'wt', 'a')).toBeNull()
    expect(chatTabShowing(older, 'wt', 'b')).toBeNull()
  })
})
