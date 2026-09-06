import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import {
  planMobileTerminalTabMount,
  resolveMobileTerminalTabMount
} from './mobile-terminal-tab-mount'
import type { TerminalTabPtyOwnershipState } from './terminal-tab-for-pty-id'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function state(tabCount = 1): TerminalTabPtyOwnershipState {
  return {
    tabsByWorktree: {
      wt: Array.from({ length: tabCount }, (_, index) => ({
        id: `tab-${index}`,
        ptyId: `wt@@${index}`
      }))
    } as unknown as AppState['tabsByWorktree'],
    terminalLayoutsByTabId: {},
    ptyIdsByTabId: {}
  }
}

describe('planMobileTerminalTabMount', () => {
  it('keeps real-tab requests targeted to exactly one tab', () => {
    expect(planMobileTerminalTabMount(state(), { worktreeId: 'wt', tabId: 'tab-0' })).toEqual({
      worktreeId: 'wt',
      tabIds: ['tab-0']
    })
  })

  it('resolves synthetic handles to exactly one owning tab at workspace scale', () => {
    expect(planMobileTerminalTabMount(state(200), { worktreeId: 'wt', ptyId: 'wt@@173' })).toEqual({
      worktreeId: 'wt',
      tabIds: ['tab-173']
    })
  })

  it('does not mount the whole worktree when a stale pty id has no owner', () => {
    expect(
      planMobileTerminalTabMount(state(200), { worktreeId: 'wt', ptyId: 'wt@@missing' })
    ).toBeNull()
  })

  it('does not mount either tab when stale persistence has duplicate pty ownership', () => {
    const s = state(200)
    s.terminalLayoutsByTabId['tab-199'] = {
      root: null,
      activeLeafId: null,
      expandedLeafId: null,
      ptyIdsByLeafId: { leaf: 'wt@@173' }
    }

    expect(planMobileTerminalTabMount(s, { worktreeId: 'wt', ptyId: 'wt@@173' })).toBeNull()
  })

  it('mounts the tab whose pane is mounted when a stale layout row also claims the pty', () => {
    const s = state(200)
    s.ptyIdsByTabId['tab-173'] = ['wt@@173']
    s.terminalLayoutsByTabId['tab-199'] = {
      root: null,
      activeLeafId: null,
      expandedLeafId: null,
      ptyIdsByLeafId: { leaf: 'wt@@173' }
    }

    expect(planMobileTerminalTabMount(s, { worktreeId: 'wt', ptyId: 'wt@@173' })).toEqual({
      worktreeId: 'wt',
      tabIds: ['tab-173']
    })
  })

  it('does not mount a hidden worktree for a stale direct tab id', () => {
    const isTabMounted = vi.fn()

    expect(
      planMobileTerminalTabMount(
        state(200),
        { worktreeId: 'wt', tabId: 'tab-missing' },
        { isTabMounted }
      )
    ).toBeNull()
    expect(isTabMounted).not.toHaveBeenCalled()
  })

  it('does not schedule hidden layout work for an already-mounted tab', () => {
    const isTabMounted = vi.fn().mockReturnValue(true)

    expect(
      planMobileTerminalTabMount(
        state(200),
        { worktreeId: 'wt', ptyId: 'wt@@173' },
        { isTabMounted }
      )
    ).toBeNull()
    expect(isTabMounted).toHaveBeenCalledTimes(1)
    expect(isTabMounted).toHaveBeenCalledWith('tab-173', 'wt')
  })

  it('passes the requested worktree to the mounted-tab predicate', () => {
    const isTabMounted = vi.fn(() => false)

    expect(
      planMobileTerminalTabMount(state(), { worktreeId: 'wt', tabId: 'tab-0' }, { isTabMounted })
    ).toEqual({ worktreeId: 'wt', tabIds: ['tab-0'] })
    expect(isTabMounted).toHaveBeenCalledWith('tab-0', 'wt')
  })
})

describe('resolveMobileTerminalTabMount', () => {
  // Why the distinction matters: a slept pane whose tab is still mounted cannot
  // be woken by a mount — the caller must fire the in-place wake instead, so
  // "already mounted" must be distinguishable from "tab does not resolve".
  it('reports an already-mounted tab instead of collapsing it into null', () => {
    expect(
      resolveMobileTerminalTabMount(
        state(),
        { worktreeId: 'wt', tabId: 'tab-0' },
        { isTabMounted: () => true }
      )
    ).toEqual({ kind: 'already-mounted', tabId: 'tab-0' })
  })

  it('plans a mount for an unmounted resolvable tab', () => {
    expect(
      resolveMobileTerminalTabMount(
        state(),
        { worktreeId: 'wt', tabId: 'tab-0' },
        { isTabMounted: () => false }
      )
    ).toEqual({ kind: 'mount', detail: { worktreeId: 'wt', tabIds: ['tab-0'] } })
  })

  it('scopes an inbound-message mount to its addressed split leaf', () => {
    expect(
      resolveMobileTerminalTabMount(
        state(),
        {
          worktreeId: 'wt',
          tabId: 'tab-0',
          paneKey: `tab-0:${LEAF_ID}`,
          intent: 'inbound-message'
        },
        { isTabMounted: () => false }
      )
    ).toEqual({
      kind: 'mount',
      detail: {
        worktreeId: 'wt',
        tabIds: ['tab-0'],
        coldRestorePaneKeysByTabId: { 'tab-0': [`tab-0:${LEAF_ID}`] }
      }
    })
  })

  it('keeps client-subscribe mounts unscoped even when they carry pane identity', () => {
    expect(
      resolveMobileTerminalTabMount(
        state(),
        {
          worktreeId: 'wt',
          tabId: 'tab-0',
          paneKey: `tab-0:${LEAF_ID}`,
          intent: 'client-subscribe'
        },
        { isTabMounted: () => false }
      )
    ).toEqual({ kind: 'mount', detail: { worktreeId: 'wt', tabIds: ['tab-0'] } })
  })

  it('does not widen malformed inbound pane identity into an unscoped mount', () => {
    expect(
      resolveMobileTerminalTabMount(
        state(),
        {
          worktreeId: 'wt',
          tabId: 'tab-0',
          paneKey: 'tab-0:not-a-stable-leaf',
          intent: 'inbound-message'
        },
        { isTabMounted: () => false }
      )
    ).toBeNull()
  })

  it('returns null when the tab does not resolve at all', () => {
    expect(
      resolveMobileTerminalTabMount(
        state(),
        { worktreeId: 'wt', tabId: 'tab-missing' },
        { isTabMounted: () => true }
      )
    ).toBeNull()
  })
})
