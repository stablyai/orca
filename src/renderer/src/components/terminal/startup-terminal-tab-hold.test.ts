// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'

import { shouldMountBackgroundWorktreeTab } from './background-terminal-worktree-mount'
import {
  holdTerminalTabsForStartup,
  releaseStartupTerminalTabHold,
  type StartupTerminalTabHold
} from './startup-terminal-tab-hold'

describe('holdTerminalTabsForStartup', () => {
  it('admits no terminal tab of a worktree that has not mounted yet', () => {
    const hold: { current: StartupTerminalTabHold | null } = { current: null }
    const restrictions = new Map<string, ReadonlySet<string>>()
    const mounted = new Set<string>()

    holdTerminalTabsForStartup(hold, restrictions, mounted, 'wt-active', ['tab-1'])

    expect(restrictions.get('wt-active')).toEqual(new Set())
    expect(mounted.has('wt-active')).toBe(true)
    expect(shouldMountBackgroundWorktreeTab(restrictions.get('wt-active') ?? null, 'tab-1')).toBe(
      false
    )
    expect(hold.current).toEqual({ worktreeId: 'wt-active', heldTabIds: new Set(['tab-1']) })
  })

  it('keeps a targeted background mount that landed first and never narrows a full mount', () => {
    const hold: { current: StartupTerminalTabHold | null } = { current: null }
    const restrictions = new Map<string, ReadonlySet<string>>([['wt-active', new Set(['tab-1'])]])
    const mounted = new Set<string>(['wt-full'])

    holdTerminalTabsForStartup(hold, restrictions, mounted, 'wt-active', ['tab-1', 'tab-2'])
    expect(restrictions.get('wt-active')).toEqual(new Set(['tab-1']))
    expect(hold.current?.heldTabIds).toEqual(new Set(['tab-2']))

    releaseStartupTerminalTabHold(hold, restrictions, mounted, 'wt-full')
    holdTerminalTabsForStartup(hold, restrictions, mounted, 'wt-full', ['tab-1'])
    expect(restrictions.has('wt-full')).toBe(false)
    expect(hold.current?.heldTabIds).toEqual(new Set())
  })

  it('releases an unwidened hold and leaves a widened one as a targeted restriction', () => {
    const hold: { current: StartupTerminalTabHold | null } = { current: null }
    const restrictions = new Map<string, ReadonlySet<string>>()
    const mounted = new Set<string>()
    holdTerminalTabsForStartup(hold, restrictions, mounted, 'wt-previous', ['tab-1'])

    releaseStartupTerminalTabHold(hold, restrictions, mounted, 'wt-previous')
    expect(hold.current?.worktreeId).toBe('wt-previous')

    releaseStartupTerminalTabHold(hold, restrictions, mounted, null)
    expect(restrictions.has('wt-previous')).toBe(false)
    expect(mounted.has('wt-previous')).toBe(false)
    expect(hold.current).toBeNull()

    holdTerminalTabsForStartup(hold, restrictions, mounted, 'wt-targeted', ['tab-wake', 'tab-2'])
    restrictions.set('wt-targeted', new Set(['tab-wake']))
    releaseStartupTerminalTabHold(hold, restrictions, mounted, 'wt-active')
    expect(restrictions.get('wt-targeted')).toEqual(new Set(['tab-wake']))
    expect(mounted.has('wt-targeted')).toBe(true)
  })
})
