import { describe, expect, it } from 'vitest'
import { applyTerminalColdActivation } from './terminal-cold-activation'

describe('applyTerminalColdActivation', () => {
  it('mounts startup portal tabs through an existing background restriction', () => {
    const restrictions = new Map<string, ReadonlySet<string>>([
      ['worktree-a', new Set(['terminal-a'])]
    ])
    const mounted = new Set<string>()

    applyTerminalColdActivation({
      activationDeferredMountTabIdsByWorktreeRef: { current: new Map() },
      activityTerminalPortals: [{ worktreeId: 'worktree-a', tabId: 'terminal-b' }],
      backgroundMountTabIdsByWorktreeRef: { current: restrictions },
      mountedWorktreeIdsRef: { current: mounted },
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      startupWorktreeRefreshCompleted: false,
      renderedActiveWorktreeId: null,
      lastActivationWorktreeIdRef: { current: null },
      tabsByWorktree: { 'worktree-a': [{ id: 'terminal-a' }, { id: 'terminal-b' }] },
      workspaceSurfaceIds: ['worktree-a'],
      workspaceSurfaceIdSet: new Set(['worktree-a']),
      layoutByWorktree: {},
      groupsByWorktree: {},
      activeGroupIdByWorktree: {}
    } as unknown as Parameters<typeof applyTerminalColdActivation>[0])

    expect(mounted).toEqual(new Set(['worktree-a']))
    expect(restrictions.get('worktree-a')).toEqual(new Set(['terminal-a', 'terminal-b']))
  })
})
