import { markStructuredAgentSessionLaunchCancelled } from '@/lib/agent-session/launch/structured-agent-session-launch-cancel'
// @vitest-environment happy-dom

// Local layout-owner main records cancellation; paired hosts retain tombstones in either build.
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

import type { StructuredLaunchSlotOwner } from '@/lib/agent-session/launch/structured-agent-session-launch-slot'

const mocks = vi.hoisted(() => ({
  layoutOwnerIsMain: true,
  closeSession:
    vi.fn<(target: RuntimeClientTarget, sessionId: string) => Promise<'closed' | 'unsupported'>>(),
  callRuntime:
    vi.fn<(target: RuntimeClientTarget, method: string, params?: unknown) => Promise<unknown>>()
}))

vi.mock('../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))
vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-prompt', () => ({
  discardStructuredAgentSessionChatSends: vi.fn()
}))
vi.mock('./structured-agent-session-close', () => ({
  closeStructuredAgentSession: mocks.closeSession
}))
vi.mock('./rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.callRuntime
}))
vi.mock('./local-session-tab-close-owner', () => ({
  withLocalSessionTabCloseOwner: async (_w: string, _t: string, close: () => Promise<unknown>) =>
    close()
}))
vi.mock('./runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (worktreeId: string) => `id:${worktreeId}`
}))

import {
  hasStructuredAgentSessionLaunchCancellationTombstone,
  resetStructuredAgentLaunchRegistryForTests
} from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import {
  readStructuredAgentLaunchRecord,
  resetStructuredAgentLaunchPersistenceForTests,
  writeStructuredAgentLaunchRecord
} from '@/lib/agent-session/launch/structured-agent-session-launch-persistence'
import '@/lib/agent-session/launch/structured-agent-session-local-launch-cancel'

const WORKTREE = 'repo-1::worktree-1'
const SESSION = 'chat-1'
const LOCAL: RuntimeClientTarget = { kind: 'local' }
const layoutOwner: StructuredLaunchSlotOwner = {
  unifiedTabsByWorktree: {},
  groupsByWorktree: {},
  reorderUnifiedTabs: vi.fn()
}

/** A launch whose create is still on its way to `executionHostId`. */

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mocks.layoutOwnerIsMain = true
  mocks.closeSession.mockResolvedValue('closed')
  mocks.callRuntime.mockResolvedValue(undefined)
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
})

describe('this machine, with main owning the layout', () => {
  it('cancel after a reload, when only the saved launch is left: tells main and forgets it', () => {
    writeStructuredAgentLaunchRecord({
      sessionId: SESSION,
      executionHostId: 'local',
      agent: 'codex',
      lifecycle: 'pending',
      clientOperationId: 'operation-1',
      payloadFingerprint: 'fingerprint-1',
      expectedRuntimeFence: null
    })

    markStructuredAgentSessionLaunchCancelled(WORKTREE, SESSION, 'local', layoutOwner)

    expect(mocks.closeSession).toHaveBeenCalledWith(LOCAL, SESSION)
    expect(readStructuredAgentLaunchRecord(SESSION)).toBeUndefined()
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE, SESSION)).toBe(false)
  })
})
