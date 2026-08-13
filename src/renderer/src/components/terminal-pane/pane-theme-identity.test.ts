import { afterEach, describe, expect, it } from 'vitest'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'
import {
  _resetPaneThemeIdentityForTest,
  capturePaneThemeAgent,
  getPaneThemeAgent,
  releasePaneThemeAgent
} from './pane-theme-identity'

const CODEX_LEAF = '11111111-1111-4111-8111-111111111111' as TerminalLeafId
const CLAUDE_LEAF = '22222222-2222-4222-8222-222222222222' as TerminalLeafId
const SHELL_LEAF = '33333333-3333-4333-8333-333333333333' as TerminalLeafId

afterEach(() => {
  _resetPaneThemeIdentityForTest()
})

describe('pane-theme-identity', () => {
  it('keeps Codex root, Claude split, and shell split identities in one tab', () => {
    expect(capturePaneThemeAgent(CODEX_LEAF, undefined, 'codex')).toBe('codex')
    expect(capturePaneThemeAgent(CLAUDE_LEAF, { launchAgent: 'claude' }, 'codex')).toBe('claude')
    expect(capturePaneThemeAgent(SHELL_LEAF, null, 'codex')).toBe(null)

    expect(getPaneThemeAgent(CODEX_LEAF)).toBe('codex')
    expect(getPaneThemeAgent(CLAUDE_LEAF)).toBe('claude')
    expect(getPaneThemeAgent(SHELL_LEAF)).toBe(null)
  })

  it('ignores recapture after a fake launch registry clear', () => {
    expect(capturePaneThemeAgent(CODEX_LEAF, { launchAgent: 'codex' }, 'codex')).toBe('codex')
    expect(capturePaneThemeAgent(CODEX_LEAF, null, 'claude')).toBe('codex')
    expect(getPaneThemeAgent(CODEX_LEAF)).toBe('codex')
  })

  it('uses the tab agent only when startup is undefined', () => {
    expect(capturePaneThemeAgent(CODEX_LEAF, undefined, 'codex')).toBe('codex')
    expect(capturePaneThemeAgent(SHELL_LEAF, null, 'codex')).toBe(null)
  })

  it('lets an explicit null startup suppress the parent tab agent on first paint', () => {
    expect(capturePaneThemeAgent(SHELL_LEAF, null, 'codex')).toBe(null)
    expect(getPaneThemeAgent(SHELL_LEAF)).toBe(null)
  })

  it('releases only the closed leaf', () => {
    capturePaneThemeAgent(CODEX_LEAF, { launchAgent: 'codex' })
    capturePaneThemeAgent(CLAUDE_LEAF, { launchAgent: 'claude' })
    releasePaneThemeAgent(CODEX_LEAF)
    expect(getPaneThemeAgent(CODEX_LEAF)).toBe(null)
    expect(getPaneThemeAgent(CLAUDE_LEAF)).toBe('claude')
  })
})
