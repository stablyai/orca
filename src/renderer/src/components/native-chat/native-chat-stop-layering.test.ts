import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

function workingChatZIndex(css: string): number {
  const match =
    /\.native-chat-pane-shell:has\(\[data-native-chat-working='true'\]\)[^{]*\{[^}]*z-index:\s*(\d+);/s.exec(
      css
    )
  expect(match, 'working native-chat z-index rule not found in main.css').not.toBeNull()
  return Number(match?.[1])
}

describe('native chat Stop layering', () => {
  it('keeps a working chat pane above bottom-right product chrome', () => {
    const css = source('src/renderer/src/assets/main.css')
    const terminalPane = source(
      'src/renderer/src/components/terminal-pane/TerminalPaneNativeChatPortal.tsx'
    )

    expect(terminalPane).toContain('native-chat-pane-shell absolute inset-0 z-10')
    expect(css).toMatch(/\[data-sonner-toaster\][^{]*\{[^}]*z-index:\s*40\s*!important;/s)
    expect(workingChatZIndex(css)).toBeGreaterThan(40)
  })

  // Why both bounds: raising the working pane over the panel hides a summoned
  // floating workspace behind the chat column while an agent streams.
  it('stays under the floating workspace panel while working', () => {
    // Comments stripped first: the surrounding layering comment cites bare z-40/z-50
    // tiers, and a reworded one could otherwise be read as the panel's own class.
    const panel = source(
      'src/renderer/src/components/floating-terminal/FloatingTerminalPanelSurface.tsx'
    ).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    const panelZIndex = Number(
      /data-floating-terminal-panel[\s\S]*?className=[\s\S]*?z-\[(\d+)\]/.exec(panel)?.[1]
    )

    // FloatingTerminalPanel.bounds.test.tsx pins this same 45 through a real render.
    expect(panelZIndex).toBe(45)
    expect(workingChatZIndex(source('src/renderer/src/assets/main.css'))).toBeLessThan(panelZIndex)
  })

  it('publishes working state from both structured and bridge chat roots', () => {
    for (const path of [
      'src/renderer/src/components/native-chat/NativeChatStructuredSession.tsx',
      'src/renderer/src/components/native-chat/NativeChatResolvedView.tsx'
    ]) {
      expect(source(path)).toContain('data-native-chat-working=')
    }
  })

  it('owns structured session panes at the retained worktree overlay layer', () => {
    const terminal = source('src/renderer/src/components/TerminalWorktreeSplitSurface.tsx')
    const tabGroup = source('src/renderer/src/components/tab-group/TabGroupPanel.tsx')

    expect(terminal).toContain('<StructuredAgentSessionPaneOverlayLayer')
    expect(tabGroup).not.toContain('<NativeChatView')
  })
})
