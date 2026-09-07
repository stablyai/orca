import { describe, expect, it } from 'vitest'
import { resolveNativeChatLeafTitleAgent } from './native-chat-leaf-title-agent'

const panes = [
  { id: 1, leafId: 'leaf-1' },
  { id: 2, leafId: 'leaf-2' }
]

describe('resolveNativeChatLeafTitleAgent', () => {
  it('uses the target split leaf runtime title', () => {
    expect(
      resolveNativeChatLeafTitleAgent({
        leafId: 'leaf-2',
        panes,
        runtimePaneTitlesByPaneId: { 1: 'PowerShell', 2: '⠋ working - codex' },
        tabLabel: 'PowerShell'
      })
    ).toBe('codex')
  })

  it('does not reuse the active leaf tab label for an inactive split leaf', () => {
    expect(
      resolveNativeChatLeafTitleAgent({
        leafId: 'leaf-2',
        panes,
        runtimePaneTitlesByPaneId: { 1: 'Codex - working', 2: 'PowerShell' },
        tabLabel: 'Codex - working'
      })
    ).toBeNull()
  })

  it('does not reuse a stale tab label for the active split leaf without a runtime title', () => {
    expect(
      resolveNativeChatLeafTitleAgent({
        leafId: 'leaf-1',
        panes,
        runtimePaneTitlesByPaneId: {},
        tabLabel: 'Claude Code'
      })
    ).toBeNull()
  })

  it('keeps launch identity over a conflicting single-pane terminal title', () => {
    expect(
      resolveNativeChatLeafTitleAgent({
        leafId: 'leaf-1',
        panes: [panes[0]],
        runtimePaneTitlesByPaneId: {},
        terminalTitle: 'Claude Code',
        launchAgent: 'openclaude'
      })
    ).toBe('openclaude')
  })

  it('uses anchored title identity when no stronger evidence exists', () => {
    expect(
      resolveNativeChatLeafTitleAgent({
        leafId: 'leaf-1',
        panes: [panes[0]],
        runtimePaneTitlesByPaneId: {},
        terminalTitle: 'Claude Code'
      })
    ).toBe('claude')
  })

  it('rejects a bare free-text title when no stronger evidence exists', () => {
    expect(
      resolveNativeChatLeafTitleAgent({
        leafId: 'leaf-1',
        panes: [panes[0]],
        runtimePaneTitlesByPaneId: {},
        terminalTitle: 'grok'
      })
    ).toBeNull()
  })
})
