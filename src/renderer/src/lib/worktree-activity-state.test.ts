import { describe, expect, it } from 'vitest'
import { hasActiveWorkspaceActivity, isInactiveWorkspace } from './worktree-activity-state'
import type { TerminalTab } from '../../../shared/types'

function makeTab(id: string): Pick<TerminalTab, 'id'> {
  return { id }
}

describe('worktree activity state', () => {
  it('treats a slept wake-hint workspace as inactive', () => {
    expect(isInactiveWorkspace('wt-1', { 'wt-1': [makeTab('tab-1')] }, { 'tab-1': [] }, {})).toBe(
      true
    )
  })

  it('treats a never-opened workspace as inactive', () => {
    expect(isInactiveWorkspace('wt-1', {}, {}, {})).toBe(true)
  })

  it('treats live terminal workspaces as active', () => {
    const tabsByWorktree = { 'wt-1': [makeTab('tab-1')] }
    const ptyIdsByTabId = { 'tab-1': ['pty-1'] }

    expect(isInactiveWorkspace('wt-1', tabsByWorktree, ptyIdsByTabId, {})).toBe(false)
    expect(hasActiveWorkspaceActivity('wt-1', tabsByWorktree, ptyIdsByTabId, {})).toBe(true)
  })

  it('treats browser workspaces as active', () => {
    expect(
      isInactiveWorkspace(
        'wt-1',
        { 'wt-1': [makeTab('tab-1')] },
        { 'tab-1': [] },
        { 'wt-1': [{ id: 'browser-1' }] }
      )
    ).toBe(false)
  })

  it('treats pending paired web host terminal mirrors as inactive without a live pty', () => {
    expect(
      hasActiveWorkspaceActivity('wt-1', { 'wt-1': [makeTab('web-terminal-host-tab-1')] }, {}, {})
    ).toBe(false)
  })

  it('treats ready paired web host terminal mirrors as active with a live pty', () => {
    expect(
      hasActiveWorkspaceActivity(
        'wt-1',
        { 'wt-1': [makeTab('web-terminal-host-tab-1')] },
        { 'web-terminal-host-tab-1': ['pty-1'] },
        {}
      )
    ).toBe(true)
  })

  it('keeps browser-only workspaces active when mirrored terminals are pending', () => {
    expect(
      hasActiveWorkspaceActivity(
        'wt-1',
        { 'wt-1': [makeTab('web-terminal-host-tab-1')] },
        {},
        { 'wt-1': [{ id: 'browser-1' }] }
      )
    ).toBe(true)
  })
})
