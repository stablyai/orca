import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

describe('native chat Stop layering', () => {
  it('keeps a working chat pane above bottom-right product chrome', () => {
    const css = source('src/renderer/src/assets/main.css')
    const terminalPane = source('src/renderer/src/components/terminal-pane/TerminalPane.tsx')

    expect(terminalPane).toContain('native-chat-pane-shell absolute inset-0 z-10')
    expect(css).toMatch(/\[data-sonner-toaster\][^{]*\{[^}]*z-index:\s*40\s*!important;/s)
    expect(css).toMatch(
      /\.native-chat-pane-shell:has\(\[data-native-chat-working='true'\]\)[^{]*\{[^}]*z-index:\s*50;/s
    )
  })

  it('publishes working state from both structured and bridge chat roots', () => {
    for (const path of [
      'src/renderer/src/components/native-chat/NativeChatStructuredSession.tsx',
      'src/renderer/src/components/native-chat/NativeChatView.tsx'
    ]) {
      expect(source(path)).toContain('data-native-chat-working=')
    }
  })

  it('owns structured session panes at the retained worktree overlay layer', () => {
    const terminal = source('src/renderer/src/components/Terminal.tsx')
    const tabGroup = source('src/renderer/src/components/tab-group/TabGroupPanel.tsx')

    expect(terminal).toContain('<StructuredAgentSessionPaneOverlayLayer')
    expect(tabGroup).not.toContain('<NativeChatView')
  })
})
