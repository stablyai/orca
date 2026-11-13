// END-PASS CHAT-RENEW: every chat-side cloud check finds the chat's Orca Cloud environment the same way,
// including a chat tab the desktop created itself (no `runtime:` execution host on the tab).
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/orca-cloud/use-cloud-agent-row-sign-in', () => ({
  orcaCloudEnvironmentIdForWorktree: (_state: unknown, worktreeId: string) =>
    worktreeId === 'wt-cloud' ? 'env-owner' : null
}))

const { chatCloudEnvironmentId } = await import('./chat-cloud-environment')

const state = (executionHostId: string | undefined, worktreeId = 'wt-cloud') =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the helper reads only unifiedTabsByWorktree (the owner lookup is mocked)
  ({
    unifiedTabsByWorktree: {
      [worktreeId]: [
        {
          id: 'chat-1',
          contentType: 'agent-session',
          ...(executionHostId ? { executionHostId } : {})
        }
      ]
    }
  }) as never

describe('chatCloudEnvironmentId', () => {
  it('a host-mirrored chat tab: its runtime execution host', () => {
    expect(chatCloudEnvironmentId(state('runtime:env-mirrored'), 'chat-1')).toBe('env-mirrored')
  })
  it('a chat tab the desktop created (no runtime host): its workspace runtime owner', () => {
    expect(chatCloudEnvironmentId(state(undefined), 'chat-1')).toBe('env-owner')
    expect(chatCloudEnvironmentId(state('local'), 'chat-1')).toBe('env-owner')
  })
  it('not a cloud workspace, or no such tab: null', () => {
    expect(chatCloudEnvironmentId(state(undefined, 'wt-local'), 'chat-1')).toBeNull()
    expect(chatCloudEnvironmentId(state('runtime:env-mirrored'), 'chat-2')).toBeNull()
  })
})
