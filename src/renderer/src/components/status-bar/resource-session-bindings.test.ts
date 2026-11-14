import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import {
  buildResourceSessionBindingIndex,
  selectUnboundDaemonSessions
} from './resource-session-bindings'

function makeTab(id: string, ptyId: string | null = null): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId: 'repo::/workspace',
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    type: 'terminal',
    paneCount: 1
  } as unknown as TerminalTab
}

describe('resource session bindings', () => {
  it('binds a session deferred for SSH reattach so it is never offered for cleanup', () => {
    const inputs = {
      ptyIdsByTabId: {},
      tabsByWorktree: { 'repo::/workspace': [makeTab('tab-ssh')] },
      terminalLayoutsByTabId: {},
      deferredSshSessionIdsByTabId: { 'tab-ssh': 'pty-deferred' },
      workspaceSessionReady: true
    }

    expect(buildResourceSessionBindingIndex(inputs).boundPtyIds.has('pty-deferred')).toBe(true)
    expect(
      selectUnboundDaemonSessions(
        [
          {
            id: 'pty-deferred',
            cwd: '/workspace',
            title: 'agent',
            agentOwnership: 'absent' as const
          }
        ],
        inputs
      )
    ).toEqual([])
  })
})
