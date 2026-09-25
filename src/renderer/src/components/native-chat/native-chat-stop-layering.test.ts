import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

describe('native chat layering', () => {
  it('keeps working chat at the pane layer below app notifications and floating surfaces', () => {
    const css = source('src/renderer/src/assets/main.css')
    for (const path of [
      'src/renderer/src/components/terminal-pane/TerminalOverlaySlot.tsx',
      'src/renderer/src/components/native-chat/StructuredAgentSessionPaneOverlayLayer.tsx'
    ]) {
      expect(source(path)).toContain('<RetainedPaneHost')
    }
    expect(css).not.toMatch(/\.native-chat-pane-shell:has\(\[data-native-chat-working/)
    expect(css).toMatch(/\[data-sonner-toaster\][^{]*\{[^}]*z-index:\s*40\s*!important;/s)
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
