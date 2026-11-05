import { describe, expect, it } from 'vitest'
import { readPluginFocusedSurface } from './plugin-focused-surface'

const WT = 'repo-1::/home/me/src/app'

function session(
  tabType: 'terminal' | 'agent-session' | 'editor' | 'browser' | 'simulator',
  tab: { id: string; label: string; customLabel?: string | null }
) {
  return {
    activeWorktreeId: WT,
    activeTabTypeByWorktree: { [WT]: tabType },
    activeGroupIdByWorktree: { [WT]: 'g2' },
    tabGroups: {
      [WT]: [
        { id: 'g1', worktreeId: WT, activeTabId: 'other', tabOrder: ['other'] },
        { id: 'g2', worktreeId: WT, activeTabId: tab.id, tabOrder: [tab.id] }
      ]
    },
    unifiedTabs: {
      [WT]: [
        { id: 'other', label: 'Not this one', customLabel: null },
        { ...tab, customLabel: tab.customLabel ?? null }
      ]
    }
  } as unknown as Parameters<typeof readPluginFocusedSurface>[0]
}

describe('readPluginFocusedSurface', () => {
  it('names the active agent tab of the active group, with an id that joins its paneKey', () => {
    const agentTab = { id: 'structured-agent-session-s1', label: 'Fix the login bug' }
    expect(readPluginFocusedSurface(session('agent-session', agentTab), true)).toEqual({
      kind: 'agent',
      title: 'Fix the login bug',
      agentId: 'structured-agent-session-s1'
    })
  })

  it('never passes on a path, a URL or the worktree id', () => {
    const editor = readPluginFocusedSurface(
      session('editor', { id: 'e1', label: '/home/me/src/app/secret-plan.md' }),
      true
    )
    const browser = readPluginFocusedSurface(
      session('browser', { id: 'b1', label: 'https://internal.example.com/admin?token=abc' }),
      true
    )
    expect(editor).toEqual({ kind: 'editor', title: 'secret-plan.md' })
    expect(browser).toEqual({ kind: 'browser', title: 'internal.example.com' })
    expect(JSON.stringify([editor, browser])).not.toContain('/home/me')
  })

  it('is null while the window is unfocused or the tab kind is not shared', () => {
    const terminal = session('terminal', { id: 't1', label: 'zsh' })
    expect(readPluginFocusedSurface(terminal, true)).toEqual({ kind: 'terminal', title: 'zsh' })
    expect(readPluginFocusedSurface(terminal, false)).toBeNull()
    expect(
      readPluginFocusedSurface(session('simulator', { id: 's1', label: 'iPhone' }), true)
    ).toBeNull()
  })
})
