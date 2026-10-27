import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { parseWorkspaceSession } from '../../../../shared/workspace-session-schema'
import { createTestStore, makeWorktree, seedStore } from '../slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../slices/store-cascades-test-harness'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreCascadesMockApi()

const WT = 'repo1::/path/wt1'
const ON_HOST = {
  initialPtyId: 'ssh:builder@@pty-1',
  executionHostId: 'ssh:builder',
  projectHostSetupId: 'builder-setup'
} as const

function seededStore(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    unifiedTabsByWorktree: {}
  })
  return store
}

function unifiedTab(store: ReturnType<typeof createTestStore>, tabId: string) {
  return store.getState().unifiedTabsByWorktree[WT]?.find((tab) => tab.id === tabId)
}

describe('createTab on another host', () => {
  it('mirrors the host PTY and stores the host and setup id, persisted', () => {
    const store = seededStore()
    const tab = store.getState().createTab(WT, undefined, undefined, ON_HOST)

    expect(tab.ptyId).toBe('ssh:builder@@pty-1')
    expect(store.getState().ptyIdsByTabId[tab.id]).toEqual(['ssh:builder@@pty-1'])
    expect(unifiedTab(store, tab.id)).toMatchObject({
      executionHostId: 'ssh:builder',
      projectHostSetupId: 'builder-setup'
    })
    const payload = buildWorkspaceSessionPayload(store.getState())
    const parsed = parseWorkspaceSession(JSON.parse(JSON.stringify(payload)))
    const persisted = parsed.ok ? parsed.value.unifiedTabs?.[WT]?.[0] : undefined
    expect(persisted).toMatchObject({
      id: tab.id,
      executionHostId: 'ssh:builder',
      projectHostSetupId: 'builder-setup'
    })
  })

  it('leaves a create without a host exactly as before', () => {
    const store = seededStore()
    const tab = store.getState().createTab(WT, undefined, 'zsh')
    const created = unifiedTab(store, tab.id)

    expect(created).toBeDefined()
    expect(created && 'executionHostId' in created).toBe(false)
    expect(created && 'projectHostSetupId' in created).toBe(false)
    expect(tab.ptyId).toBeNull()
    expect(tab.shellOverride).toBe('zsh')
  })

  it('does not carry this machine shell choice onto a remote host', () => {
    const store = seededStore()
    const tab = store.getState().createTab(WT, undefined, 'zsh', ON_HOST)

    expect(tab.shellOverride).toBeUndefined()
  })

  it('keeps a corrupt persisted setup id verbatim as remote intent, without discarding the tab', () => {
    const store = seededStore()
    const tab = store.getState().createTab(WT, undefined, undefined, ON_HOST)
    const payload = JSON.parse(JSON.stringify(buildWorkspaceSessionPayload(store.getState())))
    payload.unifiedTabs[WT][0].projectHostSetupId = 42

    const parsed = parseWorkspaceSession(payload)
    const restored = parsed.ok ? parsed.value.unifiedTabs?.[WT]?.[0] : undefined
    expect(restored?.id).toBe(tab.id)
    expect(restored?.projectHostSetupId).toBe(42)
    expect(restored?.executionHostId).toBe('ssh:builder')
  })
})
