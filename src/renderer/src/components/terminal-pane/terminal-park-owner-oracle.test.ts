import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import {
  replaceWebSessionTerminalParkAuthority,
  resetWebSessionTerminalParkAuthorityForTests
} from '@/runtime/web-session-terminal-park-authority'
import type { TerminalParkWorktreeOwner } from './terminal-park-pty-restore-eligibility'
import { canParkTerminalWorktreeRenderers } from './terminal-hidden-view-parking'
import {
  isEvictionExemptTerminalPty,
  selectForceParkEvictableTabIds,
  selectRetentionForceParkedTerminalWorktrees
} from './terminal-hidden-worktree-retention'

const WORKTREE_ID = 'repo::/worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TAB_ID = toWebTerminalSurfaceTabId('host-tab')

function oracleOwner(
  owner: TerminalParkWorktreeOwner,
  legacy: { connectionId: string | null | undefined; runtimeEnvironmentId: string | null }
): TerminalParkWorktreeOwner {
  return { ...owner, ...legacy } as TerminalParkWorktreeOwner
}

const LOCAL_OWNER = oracleOwner(
  { kind: 'local' },
  { connectionId: null, runtimeEnvironmentId: null }
)
const UNKNOWN_OWNER = oracleOwner(
  { kind: 'unknown' },
  { connectionId: undefined, runtimeEnvironmentId: null }
)
const AMBIGUOUS_OWNER = oracleOwner(
  { kind: 'ambiguous' },
  { connectionId: null, runtimeEnvironmentId: null }
)
const SSH_OWNER = oracleOwner(
  { kind: 'ssh', connectionId: 'ssh-owner' },
  { connectionId: 'ssh-owner', runtimeEnvironmentId: null }
)
const RUNTIME_OWNER = oracleOwner(
  { kind: 'runtime', environmentId: 'env-owner' },
  { connectionId: null, runtimeEnvironmentId: 'env-owner' }
)

function canParkRemotePty(args: {
  ptyId: string
  owner: TerminalParkWorktreeOwner
  worktreeId?: string
  tabId?: string
  leafId?: string
}): boolean {
  return canParkTerminalWorktreeRenderers({
    worktreeId: args.worktreeId ?? WORKTREE_ID,
    worktreeOwner: args.owner,
    terminalTabs: [
      { id: args.tabId ?? TAB_ID, ptyId: args.ptyId, activeLeafId: args.leafId ?? LEAF_ID }
    ],
    pendingStartupByTabId: {},
    parkingEnabled: true,
    isVisible: false,
    shouldMeasureHiddenWorktree: false,
    hasActivityTerminalPortal: false,
    hiddenSinceMs: 0,
    nowMs: 1,
    coldParkDelayMs: 0,
    restorePolicy: {
      sshParkingEnabled: true,
      pairedRuntimeParkingEnvironmentIds: new Set(['env-owner', 'env-foreign'])
    }
  })
}

function mirrorSnapshot(terminal = 'pty-mirror', version = 1): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'epoch-1',
    snapshotVersion: version,
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
        status: 'ready',
        terminal
      }
    ]
  }
}

describe('remote PTY parking owner oracle', () => {
  afterEach(() => resetWebSessionTerminalParkAuthorityForTests())

  it('permits only exact authoritative runtime and SSH matches', () => {
    expect(
      canParkRemotePty({
        ptyId: 'remote:env-owner@@pty-1',
        owner: RUNTIME_OWNER
      })
    ).toBe(true)
    expect(
      canParkRemotePty({
        ptyId: 'ssh:ssh-owner@@pty-1',
        owner: SSH_OWNER
      })
    ).toBe(true)
  })

  it.each([
    ['local runtime', 'remote:env-owner@@pty-1', LOCAL_OWNER],
    ['unknown runtime', 'remote:env-owner@@pty-1', UNKNOWN_OWNER],
    ['ambiguous runtime', 'remote:env-owner@@pty-1', AMBIGUOUS_OWNER],
    ['SSH-shaped runtime', 'remote:env-owner@@pty-1', SSH_OWNER],
    ['foreign runtime', 'remote:env-foreign@@pty-1', RUNTIME_OWNER],
    ['local SSH', 'ssh:ssh-owner@@pty-1', LOCAL_OWNER],
    ['unknown SSH', 'ssh:ssh-owner@@pty-1', UNKNOWN_OWNER],
    ['ambiguous SSH', 'ssh:ssh-owner@@pty-1', AMBIGUOUS_OWNER],
    ['runtime-shaped SSH', 'ssh:ssh-owner@@pty-1', RUNTIME_OWNER],
    ['foreign SSH', 'ssh:ssh-foreign@@pty-1', SSH_OWNER]
  ] as const)('rejects %s ownership', (_name, ptyId, owner) => {
    expect(canParkRemotePty({ ptyId, owner })).toBe(false)
  })

  it.each([
    ['paired-runtime', 'remote:env-foreign@@pty-1', RUNTIME_OWNER],
    ['SSH', 'ssh:ssh-foreign@@pty-1', SSH_OWNER]
  ] as const)(
    'keeps a proven-foreign %s PTY mounted when retention force-parks',
    (_name, ptyId, owner) => {
      const forceParked = selectRetentionForceParkedTerminalWorktrees({
        worktrees: [
          {
            worktreeId: WORKTREE_ID,
            hiddenSinceMs: 0,
            isVisible: false,
            shouldMeasureHiddenWorktree: false,
            hasActivityTerminalPortal: false,
            ordinaryParkingCovers: false,
            hasPendingSpawnWork: false
          }
        ],
        parkingEnabled: true,
        retentionBudgetEnabled: true,
        nowMs: 2,
        coldParkDelayMs: 0,
        retentionTtlMs: 1
      })
      const ownerAwareExemption = isEvictionExemptTerminalPty as (
        candidatePtyId: string,
        worktreeId: string,
        worktreeOwner: TerminalParkWorktreeOwner,
        paneIdentity: { tabId: string; leafId: string }
      ) => boolean

      expect(forceParked).toEqual(new Set([WORKTREE_ID]))
      expect(
        selectForceParkEvictableTabIds([{ id: TAB_ID }], () =>
          ownerAwareExemption(ptyId, WORKTREE_ID, owner, { tabId: TAB_ID, leafId: LEAF_ID })
        )
      ).toEqual([])
    }
  )

  it('permits the exact local web-mirror session and rejects every near miss', () => {
    replaceWebSessionTerminalParkAuthority(mirrorSnapshot(), 'env-owner')
    const ptyId = 'remote:env-owner@@pty-mirror'
    expect(canParkRemotePty({ ptyId, owner: LOCAL_OWNER })).toBe(true)
    expect(canParkRemotePty({ ptyId, owner: LOCAL_OWNER, worktreeId: 'repo::/other' })).toBe(false)
    expect(canParkRemotePty({ ptyId, owner: LOCAL_OWNER, tabId: 'web-terminal-other' })).toBe(false)
    expect(
      canParkRemotePty({
        ptyId,
        owner: LOCAL_OWNER,
        leafId: '22222222-2222-4222-8222-222222222222'
      })
    ).toBe(false)
    expect(
      canParkRemotePty({
        ptyId: 'remote:env-owner@@pty-reminted',
        owner: LOCAL_OWNER
      })
    ).toBe(false)
  })

  it('revokes a prior mirror session on remint', () => {
    replaceWebSessionTerminalParkAuthority(mirrorSnapshot(), 'env-owner')
    replaceWebSessionTerminalParkAuthority(mirrorSnapshot('pty-reminted', 2), 'env-owner')
    expect(
      canParkRemotePty({
        ptyId: 'remote:env-owner@@pty-mirror',
        owner: LOCAL_OWNER
      })
    ).toBe(false)
    expect(
      canParkRemotePty({
        ptyId: 'remote:env-owner@@pty-reminted',
        owner: LOCAL_OWNER
      })
    ).toBe(true)
  })
})
