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
        runtimePaneTitlesByPaneId: { 1: 'PowerShell', 2: 'Codex - working' },
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

  it('falls back to the terminal title in a single pane', () => {
    expect(
      resolveNativeChatLeafTitleAgent({
        leafId: 'leaf-1',
        panes: [panes[0]],
        runtimePaneTitlesByPaneId: {},
        terminalTitle: 'OpenClaude'
      })
    ).toBe('openclaude')
  })
})
