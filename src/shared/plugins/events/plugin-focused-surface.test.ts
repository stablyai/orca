import { describe, expect, it } from 'vitest'
import { readPluginFocusedSurface } from './plugin-focused-surface'

const WT = 'repo-1::/home/me/src/app'

function session(
  contentType: 'terminal' | 'agent-session' | 'editor' | 'diff' | 'browser' | 'simulator',
  tab: { id: string; label: string; customLabel?: string | null; entityId?: string }
) {
  return {
    activeWorktreeId: WT,
    // Stale on purpose: the kind must come from the resolved tab, not this stored value.
    activeTabTypeByWorktree: { [WT]: 'agent-session' },
    activeGroupIdByWorktree: { [WT]: 'g2' },
    tabGroups: {
      [WT]: [
        { id: 'g1', worktreeId: WT, activeTabId: 'other', tabOrder: ['other'] },
        { id: 'g2', worktreeId: WT, activeTabId: tab.id, tabOrder: [tab.id] }
      ]
    },
    unifiedTabs: {
      [WT]: [
        { id: 'other', contentType: 'terminal', label: 'Not this one', customLabel: null },
        { ...tab, contentType, customLabel: tab.customLabel ?? null }
      ]
    }
  } as unknown as Parameters<typeof readPluginFocusedSurface>[0]
}

describe('readPluginFocusedSurface', () => {
  it('names the active agent tab of the active group, with the canonical id its paneKey starts with', () => {
    // An alias tab: its own id differs from the canonical one the status rows use.
    const agentTab = { id: 'opening-tab', entityId: 's1', label: 'Fix the login bug' }
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
    const ssh = readPluginFocusedSurface(
      session('terminal', { id: 't1', label: 'ssh://alice:hunter2@build.example.com/srv' }),
      true
    )
    const mail = readPluginFocusedSurface(
      session('browser', { id: 'b2', label: 'mailto:alice@example.com?subject=secret' }),
      true
    )
    const bareHttps = readPluginFocusedSurface(
      session('browser', { id: 'b3', label: 'https:example.com?token=abc' }),
      true
    )
    const colonTitle = readPluginFocusedSurface(
      session('terminal', { id: 't2', label: 'Task: fix bug' }),
      true
    )
    const share = readPluginFocusedSurface(
      session('editor', { id: 'f2', label: 'file://fileserver/share/report.txt' }),
      true
    )
    const fileUrl = readPluginFocusedSurface(
      session('editor', { id: 'f1', label: 'file:///home/me/report.txt?token=abc#top' }),
      true
    )
    expect(editor).toEqual({ kind: 'editor', title: 'secret-plan.md' })
    expect(browser).toEqual({ kind: 'browser', title: 'internal.example.com' })
    expect(fileUrl).toEqual({ kind: 'editor', title: 'report.txt' })
    expect(share).toEqual({ kind: 'editor', title: 'report.txt' })
    expect(bareHttps).toEqual({ kind: 'browser', title: 'example.com' })
    expect(colonTitle).toEqual({ kind: 'terminal', title: 'Task: fix bug' })
    expect(ssh).toEqual({ kind: 'terminal', title: 'build.example.com' })
    expect(mail).toEqual({ kind: 'browser', title: null })
    expect(JSON.stringify([editor, browser, fileUrl, share, bareHttps, ssh, mail])).not.toMatch(
      /\/home\/me|token|alice|hunter2|subject|fileserver/
    )
  })

  it('is null while the window is unfocused, no tab is active, or the tab kind is not shared', () => {
    const terminal = session('terminal', { id: 't1', label: 'zsh' })
    expect(readPluginFocusedSurface(terminal, true)).toEqual({ kind: 'terminal', title: 'zsh' })
    expect(readPluginFocusedSurface(terminal, false)).toBeNull()
    const emptyGroup = session('terminal', { id: 't1', label: 'zsh' })
    emptyGroup.tabGroups![WT]![1]!.activeTabId = null
    expect(readPluginFocusedSurface(emptyGroup, true)).toBeNull()
    expect(
      readPluginFocusedSurface(session('simulator', { id: 's1', label: 'iPhone' }), true)
    ).toBeNull()
  })
})
