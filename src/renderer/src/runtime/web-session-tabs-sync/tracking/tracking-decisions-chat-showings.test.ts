// A remote frame names its chat tabs' showings only once it is accepted: a late frame from a
// retired publication must not leave its stale name behind for the tab's "x".
import { beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  chatTabShowing,
  resetChatTabShowingsForTests
} from '../../native-chat/tab-retirement/chat-tab-showings'
import { decideWebSessionTabsSnapshot } from './tracking-decisions'
import {
  clearWebSessionTerminalOrphanRecoveryForTests,
  recoverWebSessionTerminalOrphansBeforeApply
} from '../../hosted-terminals/recovery/web-session-terminal-orphan-recovery'
import type { TerminalOrphanRecoveryState } from '../../hosted-terminals/recovery/surfaces/web-session-terminal-orphan-recovery-surface'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './tracking-lifecycle'

const ENV = 'server-1'
const HOST = { kind: 'environment', environmentId: ENV } as const

function frame(epoch: string, version: number, showing: string): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'repo::wt',
    publicationEpoch: epoch,
    snapshotVersion: version,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [
      {
        type: 'agent-session',
        id: 'tab-a',
        title: 'a',
        sessionId: 'a',
        agent: 'claude',
        isActive: false,
        showing
      }
    ]
  }
}

beforeEach(() => {
  clearWebSessionTerminalOrphanRecoveryForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
  resetChatTabShowingsForTests()
})

describe("a remote frame's chat tab showings", () => {
  it('come only from accepted frames: a late frame of a retired publication changes nothing', () => {
    expect(decideWebSessionTabsSnapshot(frame('epoch-old', 1, 'old'), ENV).apply).toBe(true)
    expect(decideWebSessionTabsSnapshot(frame('epoch-new', 1, 'new'), ENV).apply).toBe(true)
    expect(chatTabShowing(HOST, 'repo::wt', 'a')).toBe('new')

    expect(decideWebSessionTabsSnapshot(frame('epoch-old', 2, 'stale'), ENV).apply).toBe(false)
    expect(chatTabShowing(HOST, 'repo::wt', 'a')).toBe('new')
  })

  it('come from no frame the decision outranks within its publication', () => {
    expect(decideWebSessionTabsSnapshot(frame('epoch-1', 5, 'current'), ENV).apply).toBe(true)
    expect(decideWebSessionTabsSnapshot(frame('epoch-1', 4, 'older'), ENV).apply).toBe(false)
    expect(chatTabShowing(HOST, 'repo::wt', 'a')).toBe('current')
  })

  it('come from no frame recovery sees before the decision drops it', async () => {
    const empty: TerminalOrphanRecoveryState = {
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      activeTabIdByWorktree: {},
      activeGroupIdByWorktree: {}
    }
    // As the event path does: orphan recovery first, then the acceptance decision.
    const receive = async (next: RuntimeMobileSessionTabsResult) => {
      const recovered = await recoverWebSessionTerminalOrphansBeforeApply(empty, next, ENV)
      return recovered ? decideWebSessionTabsSnapshot(recovered, ENV).apply : false
    }

    expect(await receive(frame('epoch-old', 1, 'old'))).toBe(true)
    expect(await receive(frame('epoch-new', 1, 'new'))).toBe(true)
    expect(await receive(frame('epoch-old', 2, 'stale'))).toBe(false)
    expect(chatTabShowing(HOST, 'repo::wt', 'a')).toBe('new')
  })
})
