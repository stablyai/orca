import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'

const mocks = vi.hoisted(() => ({ hasHostSessionMirrorHydrated: vi.fn() }))

vi.mock('@/runtime/host-session-mirror-hydration', () => ({
  hasHostSessionMirrorHydrated: mocks.hasHostSessionMirrorHydrated
}))
vi.mock('./host-mirror-handle-gap-wait', () => ({ hasHostMirrorHandleWaitExpired: () => false }))

import { findUnhydratedHostMirrorForPane } from './host-mirrored-pane-liveness'

const WORKTREE_ID = 'repo::/w'
const TAB_ID = toWebTerminalSurfaceTabId('host-tab-1')
type OwnerHost = 'local' | 'runtime:env-b'

const RECORD: SleepingAgentSessionRecord = {
  paneKey: `${TAB_ID}:leaf-1`,
  tabId: TAB_ID,
  worktreeId: WORKTREE_ID,
  agent: 'claude',
  providerSession: { key: 'session_id', id: 's-1' },
  prompt: '',
  state: 'done',
  capturedAt: 1,
  updatedAt: 1
}

function stateOwnedBy(...hostIds: OwnerHost[]) {
  const state = {
    repos: hostIds.map((hostId) => ({ id: 'repo', executionHostId: hostId })),
    worktreesByRepo: {
      repo: hostIds.map((hostId) => ({
        id: WORKTREE_ID,
        repoId: 'repo',
        hostId,
        ...(hostId === 'local' ? {} : { runtimeOwnerEnvironmentId: 'env-b' })
      }))
    },
    tabsByWorktree: { [WORKTREE_ID]: [{ id: TAB_ID }] },
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {
      [TAB_ID]: { ptyIdsByLeafId: { 'leaf-1': toRemoteRuntimePtyId('h-1', 'env-b') } }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the function reads only the owner rows and the tab/PTY maps seeded here.
  return state as unknown as Parameters<typeof findUnhydratedHostMirrorForPane>[1]
}

describe('findUnhydratedHostMirrorForPane owner', () => {
  beforeEach(() => {
    mocks.hasHostSessionMirrorHydrated.mockReset().mockReturnValue(true)
  })

  it("waits on the runtime owner's handle for a pane bound to its PTY", () => {
    expect(findUnhydratedHostMirrorForPane(RECORD, stateOwnedBy('runtime:env-b'))).toEqual({
      kind: 'handle',
      environmentId: 'env-b',
      tabId: TAB_ID
    })
  })

  it('parks a local twin of the server without arming a wait on either host', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(findUnhydratedHostMirrorForPane(RECORD, stateOwnedBy('local', 'runtime:env-b'))).toEqual(
      { kind: 'mirror', environmentId: null }
    )
    expect(mocks.hasHostSessionMirrorHydrated).not.toHaveBeenCalled()
    expect(warn.mock.calls[0]).toContain(WORKTREE_ID)
    warn.mockRestore()
  })
})
