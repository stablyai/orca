import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import {
  clearWebSessionTerminalParkAuthorityForEnvironment,
  getWebSessionTerminalParkAuthorityCountForTests,
  hasWebSessionTerminalParkAuthority,
  replaceWebSessionTerminalParkAuthority,
  resetWebSessionTerminalParkAuthorityForTests
} from './web-session-terminal-park-authority'
import {
  resetWebSessionTabsSnapshotFreshnessForTests,
  shouldApplyWebSessionTabsSnapshot
} from './web-session-tabs-sync'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const WORKTREE_ID = 'repo::/worktree'
const TAB_ID = toWebTerminalSurfaceTabId('host-tab')

function snapshot(
  args: {
    epoch?: string
    version?: number
    terminal?: string
    status?: 'ready' | 'pending-handle'
  } = {}
): RuntimeMobileSessionTabsResult {
  const status = args.status ?? 'ready'
  const terminalState =
    status === 'ready'
      ? ({ status: 'ready', terminal: args.terminal ?? 'pty-1' } as const)
      : ({ status: 'pending-handle', terminal: null } as const)
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: args.epoch ?? 'epoch-1',
    snapshotVersion: args.version ?? 1,
    activeGroupId: null,
    activeTabId: 'host-pane',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'host-pane',
        parentTabId: 'host-tab',
        leafId: LEAF_ID,
        title: 'Terminal',
        isActive: true,
        ...terminalState
      }
    ]
  }
}

function has(environmentId: string, terminal: string): boolean {
  return hasWebSessionTerminalParkAuthority({
    environmentId,
    worktreeId: WORKTREE_ID,
    tabId: TAB_ID,
    leafId: LEAF_ID,
    ptyId: `remote:${environmentId}@@${terminal}`
  })
}

describe('web session terminal park authority', () => {
  afterEach(() => {
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetWebSessionTerminalParkAuthorityForTests()
  })

  it('keeps exact same-shaped identities isolated across paired clients', () => {
    replaceWebSessionTerminalParkAuthority(snapshot(), 'env-a')
    replaceWebSessionTerminalParkAuthority(snapshot(), 'env-b')
    expect(has('env-a', 'pty-1')).toBe(true)
    expect(has('env-b', 'pty-1')).toBe(true)
    expect(getWebSessionTerminalParkAuthorityCountForTests()).toBe(2)
  })

  it('revokes the prior PTY across remint and host recreation', () => {
    replaceWebSessionTerminalParkAuthority(snapshot(), 'env-a')
    replaceWebSessionTerminalParkAuthority(
      snapshot({ epoch: 'epoch-2', terminal: 'pty-2' }),
      'env-a'
    )
    expect(has('env-a', 'pty-1')).toBe(false)
    expect(has('env-a', 'pty-2')).toBe(true)
  })

  it('updates only from accepted subscription order', () => {
    expect(
      shouldApplyWebSessionTabsSnapshot(snapshot({ version: 2, terminal: 'pty-2' }), 'env-a')
    ).toBe(true)
    expect(shouldApplyWebSessionTabsSnapshot(snapshot({ terminal: 'pty-stale' }), 'env-a')).toBe(
      false
    )
    expect(has('env-a', 'pty-2')).toBe(true)
    expect(has('env-a', 'pty-stale')).toBe(false)
  })

  it('grants nothing for a legacy pending-handle snapshot', () => {
    replaceWebSessionTerminalParkAuthority(snapshot({ status: 'pending-handle' }), 'env-a')
    expect(getWebSessionTerminalParkAuthorityCountForTests()).toBe(0)
  })

  it('clears one disconnected client without disturbing another', () => {
    replaceWebSessionTerminalParkAuthority(snapshot(), 'env-a')
    replaceWebSessionTerminalParkAuthority(snapshot(), 'env-b')
    clearWebSessionTerminalParkAuthorityForEnvironment('env-a')
    expect(has('env-a', 'pty-1')).toBe(false)
    expect(has('env-b', 'pty-1')).toBe(true)
  })
})
