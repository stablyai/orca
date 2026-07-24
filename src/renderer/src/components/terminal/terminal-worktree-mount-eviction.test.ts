import { describe, expect, it } from 'vitest'
import { pruneClosedBackgroundMountTabs } from './background-terminal-worktree-mount'
import {
  MAX_BACKGROUND_MOUNTED_TERMINAL_WORKTREES,
  collectLiveAgentTerminalAttribution,
  evictExcessBackgroundTerminalWorktreeMounts,
  isTerminalWorktreeEvictionSafe
} from './terminal-worktree-mount-eviction'

describe('mounted terminal worktree retention', () => {
  it('keeps retained background terminal surfaces bounded across many worktree activations', () => {
    const mountedWorktreeIds = new Set<string>()
    const hiddenSinceMsByWorktreeId = new Map<string, number>()
    const backgroundMountTabIdsByWorktree = new Map<string, ReadonlySet<string>>()
    const activationDeferredMountTabIdsByWorktree = new Map<string, ReadonlySet<string>>()
    const tabsByWorktree: Record<string, { id: string }[]> = {}
    let nowMs = 0

    // Mirrors the Terminal render pass across a long session of worktree switches:
    // activation adds the worktree, the parking effect stamps every other mounted
    // surface as hidden, then the per-render prune steps run.
    for (let index = 1; index <= 40; index++) {
      const activeWorktreeId = `wt-${index}`
      tabsByWorktree[activeWorktreeId] = [{ id: `${activeWorktreeId}-tab-1` }]
      mountedWorktreeIds.add(activeWorktreeId)
      hiddenSinceMsByWorktreeId.delete(activeWorktreeId)
      for (const worktreeId of mountedWorktreeIds) {
        if (worktreeId !== activeWorktreeId && !hiddenSinceMsByWorktreeId.has(worktreeId)) {
          hiddenSinceMsByWorktreeId.set(worktreeId, nowMs)
        }
      }
      nowMs += 60_000
      pruneClosedBackgroundMountTabs(
        backgroundMountTabIdsByWorktree,
        mountedWorktreeIds,
        tabsByWorktree,
        activationDeferredMountTabIdsByWorktree
      )
      evictExcessBackgroundTerminalWorktreeMounts({
        mountedWorktreeIds,
        hiddenSinceMsByWorktreeId,
        backgroundMountTabIdsByWorktree,
        activationDeferredMountTabIdsByWorktree,
        activeWorktreeId,
        nowMs,
        isWorktreeEvictionSafe: () => true
      })
      expect(mountedWorktreeIds.has(activeWorktreeId)).toBe(true)
    }

    // Active worktree + a bounded background working set; anything beyond leaks
    // xterm scrollback until the renderer heap hits the V8 ceiling.
    expect(mountedWorktreeIds.size).toBeLessThanOrEqual(
      1 + MAX_BACKGROUND_MOUNTED_TERMINAL_WORKTREES
    )
  })

  it('evicts the least-recently-hidden surfaces first and cleans their bookkeeping', () => {
    const mountedWorktreeIds = new Set(['wt-active', 'wt-old', 'wt-mid', 'wt-new'])
    const hiddenSinceMsByWorktreeId = new Map([
      ['wt-old', 1_000],
      ['wt-mid', 2_000],
      ['wt-new', 3_000]
    ])
    const backgroundMountTabIdsByWorktree = new Map<string, ReadonlySet<string>>([
      ['wt-old', new Set(['tab-1'])]
    ])
    const activationDeferredMountTabIdsByWorktree = new Map<string, ReadonlySet<string>>([
      ['wt-old', new Set(['tab-2'])]
    ])

    const evicted = evictExcessBackgroundTerminalWorktreeMounts({
      mountedWorktreeIds,
      hiddenSinceMsByWorktreeId,
      backgroundMountTabIdsByWorktree,
      activationDeferredMountTabIdsByWorktree,
      activeWorktreeId: 'wt-active',
      nowMs: 500_000,
      isWorktreeEvictionSafe: () => true,
      maxBackgroundMounts: 1
    })

    expect(evicted).toEqual(['wt-old', 'wt-mid'])
    expect(mountedWorktreeIds).toEqual(new Set(['wt-active', 'wt-new']))
    expect(backgroundMountTabIdsByWorktree.has('wt-old')).toBe(false)
    expect(activationDeferredMountTabIdsByWorktree.has('wt-old')).toBe(false)
    expect(hiddenSinceMsByWorktreeId.has('wt-old')).toBe(false)
    expect(hiddenSinceMsByWorktreeId.has('wt-new')).toBe(true)
  })

  it('never evicts the active worktree even when it is hidden-stamped (tasks page)', () => {
    const mountedWorktreeIds = new Set(['wt-active', 'wt-bg'])
    const hiddenSinceMsByWorktreeId = new Map([
      ['wt-active', 1_000],
      ['wt-bg', 2_000]
    ])

    const evicted = evictExcessBackgroundTerminalWorktreeMounts({
      mountedWorktreeIds,
      hiddenSinceMsByWorktreeId,
      backgroundMountTabIdsByWorktree: new Map(),
      activationDeferredMountTabIdsByWorktree: new Map(),
      activeWorktreeId: 'wt-active',
      nowMs: 500_000,
      isWorktreeEvictionSafe: () => true,
      maxBackgroundMounts: 0
    })

    expect(evicted).toEqual(['wt-bg'])
    expect(mountedWorktreeIds.has('wt-active')).toBe(true)
  })

  it('spares surfaces hidden less than the hysteresis and ones without a hidden stamp', () => {
    const mountedWorktreeIds = new Set(['wt-active', 'wt-just-hidden', 'wt-measuring'])
    const hiddenSinceMsByWorktreeId = new Map([['wt-just-hidden', 90_000]])

    const evicted = evictExcessBackgroundTerminalWorktreeMounts({
      mountedWorktreeIds,
      hiddenSinceMsByWorktreeId,
      backgroundMountTabIdsByWorktree: new Map(),
      activationDeferredMountTabIdsByWorktree: new Map(),
      activeWorktreeId: 'wt-active',
      nowMs: 100_000,
      isWorktreeEvictionSafe: () => true,
      maxBackgroundMounts: 0
    })

    expect(evicted).toEqual([])
    expect(mountedWorktreeIds.size).toBe(3)
  })

  it('keeps targeted background mounts (wake/mobile/CLI) but evicts activation-deferred visits', () => {
    const mountedWorktreeIds = new Set(['wt-active', 'wt-wake', 'wt-visited'])
    const hiddenSinceMsByWorktreeId = new Map([
      ['wt-wake', 1_000],
      ['wt-visited', 2_000]
    ])
    const backgroundMountTabIdsByWorktree = new Map<string, ReadonlySet<string>>([
      ['wt-wake', new Set(['tab-wake'])],
      ['wt-visited', new Set(['tab-shown'])]
    ])
    const activationDeferredMountTabIdsByWorktree = new Map<string, ReadonlySet<string>>([
      ['wt-visited', new Set(['tab-deferred'])]
    ])

    const evicted = evictExcessBackgroundTerminalWorktreeMounts({
      mountedWorktreeIds,
      hiddenSinceMsByWorktreeId,
      backgroundMountTabIdsByWorktree,
      activationDeferredMountTabIdsByWorktree,
      activeWorktreeId: 'wt-active',
      nowMs: 500_000,
      isWorktreeEvictionSafe: () => true,
      maxBackgroundMounts: 0
    })

    expect(evicted).toEqual(['wt-visited'])
    expect(mountedWorktreeIds).toEqual(new Set(['wt-active', 'wt-wake']))
    expect(backgroundMountTabIdsByWorktree.has('wt-wake')).toBe(true)
  })

  it('spares surfaces the safety predicate rejects', () => {
    const mountedWorktreeIds = new Set(['wt-active', 'wt-agent', 'wt-idle'])
    const hiddenSinceMsByWorktreeId = new Map([
      ['wt-agent', 1_000],
      ['wt-idle', 2_000]
    ])

    const evicted = evictExcessBackgroundTerminalWorktreeMounts({
      mountedWorktreeIds,
      hiddenSinceMsByWorktreeId,
      backgroundMountTabIdsByWorktree: new Map(),
      activationDeferredMountTabIdsByWorktree: new Map(),
      activeWorktreeId: 'wt-active',
      nowMs: 500_000,
      isWorktreeEvictionSafe: (worktreeId) => worktreeId !== 'wt-agent',
      maxBackgroundMounts: 0
    })

    expect(evicted).toEqual(['wt-idle'])
    expect(mountedWorktreeIds.has('wt-agent')).toBe(true)
  })
})

describe('isTerminalWorktreeEvictionSafe', () => {
  const worktreeId = 'wt-1'
  const daemonTab = { id: 'tab-1', ptyId: `${worktreeId}@@session-1` }
  const baseArgs = {
    worktreeId,
    pendingStartupByTabId: {},
    liveAgentWorktreeIds: new Set<string>(),
    liveAgentTabIds: new Set<string>()
  }

  it('allows snapshot-backed daemon PTYs and sessionless tabs', () => {
    expect(
      isTerminalWorktreeEvictionSafe({
        ...baseArgs,
        terminalTabs: [daemonTab, { id: 'tab-2', ptyId: null }]
      })
    ).toBe(true)
  })

  it('rejects a worktree or tab with a live agent', () => {
    expect(
      isTerminalWorktreeEvictionSafe({
        ...baseArgs,
        terminalTabs: [daemonTab],
        liveAgentWorktreeIds: new Set([worktreeId])
      })
    ).toBe(false)
    expect(
      isTerminalWorktreeEvictionSafe({
        ...baseArgs,
        terminalTabs: [daemonTab],
        liveAgentTabIds: new Set(['tab-1'])
      })
    ).toBe(false)
  })

  it('rejects pending startups and pending activation spawns', () => {
    expect(
      isTerminalWorktreeEvictionSafe({
        ...baseArgs,
        terminalTabs: [daemonTab],
        pendingStartupByTabId: { 'tab-1': { command: 'claude' } }
      })
    ).toBe(false)
    expect(
      isTerminalWorktreeEvictionSafe({
        ...baseArgs,
        terminalTabs: [{ ...daemonTab, pendingActivationSpawn: 1 }]
      })
    ).toBe(false)
  })

  it('rejects live PTYs without a local daemon snapshot (remote/SSH/fail-open)', () => {
    expect(
      isTerminalWorktreeEvictionSafe({
        ...baseArgs,
        terminalTabs: [{ id: 'tab-1', ptyId: 'remote:runtime-1:pty-1' }]
      })
    ).toBe(false)
    expect(
      isTerminalWorktreeEvictionSafe({
        ...baseArgs,
        terminalTabs: [{ id: 'tab-1', ptyId: 'separator-less-fail-open-id' }]
      })
    ).toBe(false)
    expect(
      isTerminalWorktreeEvictionSafe({
        ...baseArgs,
        terminalTabs: [{ id: 'tab-1', ptyId: 'other-worktree@@session-1' }]
      })
    ).toBe(false)
  })
})

describe('collectLiveAgentTerminalAttribution', () => {
  it('collects non-done rows by stamped worktree and pane-key tab fallback', () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const { worktreeIds, tabIds } = collectLiveAgentTerminalAttribution({
      [`tab-a:${leafId}`]: { state: 'working', paneKey: `tab-a:${leafId}`, worktreeId: 'wt-1' },
      [`tab-b:${leafId}`]: { state: 'blocked', paneKey: `tab-b:${leafId}` },
      'tab-legacy:42': { state: 'waiting', paneKey: 'tab-legacy:42' },
      [`tab-c:${leafId}`]: { state: 'done', paneKey: `tab-c:${leafId}`, worktreeId: 'wt-done' }
    })
    expect(worktreeIds).toEqual(new Set(['wt-1']))
    expect(tabIds).toEqual(new Set(['tab-a', 'tab-b', 'tab-legacy']))
  })
})
