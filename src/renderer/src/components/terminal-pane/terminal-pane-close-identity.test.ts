import { describe, expect, it } from 'vitest'
import {
  resolveTabTitleAfterPaneClose,
  shouldClearLaunchAgentForClosedPane
} from './terminal-pane-close-identity'

describe('shouldClearLaunchAgentForClosedPane', () => {
  it('clears launch identity only when the launch-owning PTY closes', () => {
    const tab = { launchAgent: 'codex' as const, ptyId: 'pty-agent' }

    expect(shouldClearLaunchAgentForClosedPane(tab, 'pty-agent')).toBe(true)
    expect(shouldClearLaunchAgentForClosedPane(tab, 'pty-shell')).toBe(false)
  })

  it('does not mutate identity-free or not-yet-bound tabs', () => {
    expect(shouldClearLaunchAgentForClosedPane({ ptyId: 'pty-1' }, 'pty-1')).toBe(false)
    expect(
      shouldClearLaunchAgentForClosedPane({ launchAgent: 'claude', ptyId: null }, 'pty-1')
    ).toBe(false)
  })
})

describe('resolveTabTitleAfterPaneClose', () => {
  it('uses the promoted sibling title when one is known', () => {
    expect(resolveTabTitleAfterPaneClose({ 2: 'codex' }, 2)).toBe('codex')
  })

  it('resets to the tab fallback when the promoted shell has no title', () => {
    expect(resolveTabTitleAfterPaneClose({ 1: 'closed agent' }, 2)).toBe('')
    expect(resolveTabTitleAfterPaneClose({}, null)).toBe('')
  })
})
