import { describe, expect, it } from 'vitest'
import { derivePluginUiFocusReport } from './plugin-ui-focus-report'

describe('derivePluginUiFocusReport', () => {
  it('reports window blur without a kind', () => {
    expect(
      derivePluginUiFocusReport({
        windowFocused: false,
        activeTabType: 'terminal',
        activeModal: 'none'
      })
    ).toEqual({ windowFocused: false })
  })

  it('maps the jump palette to command-palette', () => {
    expect(
      derivePluginUiFocusReport({
        windowFocused: true,
        activeModal: 'worktree-palette',
        activeTabType: 'terminal'
      })
    ).toEqual({ windowFocused: true, kind: 'command-palette', title: null })
  })

  it('maps agent-session, browser, and simulator tabs', () => {
    expect(
      derivePluginUiFocusReport({
        windowFocused: true,
        activeModal: 'none',
        activeTabType: 'agent-session'
      })
    ).toEqual({ windowFocused: true, kind: 'agent', title: null, agentId: null })
    expect(
      derivePluginUiFocusReport({
        windowFocused: true,
        activeModal: 'quick-open',
        activeTabType: 'browser'
      })
    ).toEqual({ windowFocused: true, kind: 'command-palette', title: null })
    expect(
      derivePluginUiFocusReport({
        windowFocused: true,
        activeModal: 'none',
        activeTabType: 'simulator'
      })
    ).toEqual({ windowFocused: true, kind: 'simulator', title: null })
  })

  it('uses the active unified tab label', () => {
    expect(
      derivePluginUiFocusReport({
        windowFocused: true,
        activeModal: 'none',
        activeTabType: 'editor',
        activeWorktreeId: 'wt-1',
        activeGroupIdByWorktree: { 'wt-1': 'g-1' },
        groupsByWorktree: { 'wt-1': [{ id: 'g-1', activeTabId: 'tab-1' }] },
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              id: 'tab-1',
              groupId: 'g-1',
              label: '/Users/private/repo/src/app.ts',
              customLabel: null
            }
          ]
        }
      })
    ).toEqual({
      windowFocused: true,
      kind: 'editor',
      title: '/Users/private/repo/src/app.ts',
      worktreeId: 'wt-1'
    })
  })

  it('reports the active worktree and agent-session tab id as join keys', () => {
    expect(
      derivePluginUiFocusReport({
        windowFocused: true,
        activeModal: 'none',
        activeTabType: 'agent-session',
        activeWorktreeId: 'repo-1::/Users/private/orca',
        activeGroupIdByWorktree: { 'repo-1::/Users/private/orca': 'g-1' },
        groupsByWorktree: {
          'repo-1::/Users/private/orca': [{ id: 'g-1', activeTabId: 'tab-agent-1' }]
        },
        unifiedTabsByWorktree: {
          'repo-1::/Users/private/orca': [
            {
              id: 'tab-agent-1',
              groupId: 'g-1',
              label: 'Claude',
              customLabel: null
            }
          ]
        }
      })
    ).toEqual({
      windowFocused: true,
      kind: 'agent',
      title: 'Claude',
      worktreeId: 'repo-1::/Users/private/orca',
      agentId: 'tab-agent-1'
    })
  })
})
