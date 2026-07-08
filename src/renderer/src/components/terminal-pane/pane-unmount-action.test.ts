import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/types'
import { resolvePaneUnmountAction } from './use-terminal-pane-lifecycle'

function tab(id: string, ptyId: string | null): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId: 'wt-1',
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

// STA-1282 gate #1 (terminal-pane-eviction.pty-alive): the unmount decision
// asserts the OUTCOME (a PTY-alive path vs destroy) across the three cases.
describe('resolvePaneUnmountAction', () => {
  it('policy-evicted with a live PTY -> park (PTY stays alive)', () => {
    expect(
      resolvePaneUnmountAction({
        isEviction: true,
        tabStillExists: true,
        tabId: 't1',
        ptyId: 'pty-1',
        worktreeTabs: [tab('t1', 'pty-1')]
      })
    ).toBe('park')
  })

  it('split-move reparent (tab alive, NOT eviction) -> detach, never park', () => {
    const action = resolvePaneUnmountAction({
      isEviction: false,
      tabStillExists: true,
      tabId: 't1',
      ptyId: 'pty-1',
      worktreeTabs: [tab('t1', 'pty-1')]
    })
    expect(action).toBe('detach')
    expect(action).not.toBe('park')
  })

  it('web/mobile session-mirror host-surface handoff (tab gone, PTY moved to sibling) -> detach, never park', () => {
    // The temporary tab is removed but its PTY now belongs to the host-surface
    // tab, so the PTY must stay alive without parking (the host re-registers it).
    const action = resolvePaneUnmountAction({
      isEviction: false,
      tabStillExists: false,
      tabId: 'temp-tab',
      ptyId: 'pty-shared',
      worktreeTabs: [tab('host-tab', 'pty-shared')]
    })
    expect(action).toBe('detach')
    expect(action).not.toBe('park')
  })

  it('an eviction can never reach a PTY-alive path when there is no PTY -> destroy', () => {
    expect(
      resolvePaneUnmountAction({
        isEviction: true,
        tabStillExists: true,
        tabId: 't1',
        ptyId: null,
        worktreeTabs: [tab('t1', null)]
      })
    ).toBe('destroy')
  })

  it('tab and worktree gone (PTY not shared) -> destroy', () => {
    expect(
      resolvePaneUnmountAction({
        isEviction: false,
        tabStillExists: false,
        tabId: 't1',
        ptyId: 'pty-1',
        worktreeTabs: []
      })
    ).toBe('destroy')
  })

  it('P0-2: a tab closed mid-eviction (live exclusive PTY) -> destroy, never park', () => {
    // Guards the orphan-PTY leak: if the user closes a tab while its eviction
    // teardown is in flight, the tab is gone by unmount time. A closed tab must
    // reach destroy() (kill the PTY) — parking it would leave a live PTY with no
    // owning tab and no close-reconcile owner. tabStillExists=false wins over the
    // eviction park branch precisely so this can never orphan.
    const action = resolvePaneUnmountAction({
      isEviction: true,
      tabStillExists: false,
      tabId: 't1',
      ptyId: 'pty-1',
      worktreeTabs: []
    })
    expect(action).toBe('destroy')
    expect(action).not.toBe('park')
  })

  it('a shared PTY is never parked even under an eviction unmount', () => {
    // Guards against two transports claiming one PTY: if the PTY still belongs to
    // a sibling tab, detach wins over park regardless of the eviction flag.
    expect(
      resolvePaneUnmountAction({
        isEviction: true,
        tabStillExists: true,
        tabId: 'temp-tab',
        ptyId: 'pty-shared',
        worktreeTabs: [tab('temp-tab', 'pty-shared'), tab('host-tab', 'pty-shared')]
      })
    ).toBe('detach')
  })
})
