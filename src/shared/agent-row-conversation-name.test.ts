import { describe, expect, it } from 'vitest'
import {
  getAgentRowConversationName,
  type ConversationNameTab
} from './agent-row-conversation-name'

function makeTab(overrides: Partial<ConversationNameTab> = {}): ConversationNameTab {
  return { customTitle: null, title: '', ...overrides }
}

describe('getAgentRowConversationName', () => {
  it('prefers the manual tab rename over every other source', () => {
    const tab = makeTab({
      customTitle: 'Patient sync spike',
      quickCommandLabel: 'Run tests',
      generatedTitle: 'Fix intake flow',
      title: '✳ Investigate replay bug'
    })
    expect(getAgentRowConversationName(tab, 'claude', true)).toBe('Patient sync spike')
  })

  it('falls back to the quick-command label before titles', () => {
    const tab = makeTab({ quickCommandLabel: 'Run tests', title: '✳ Investigate replay bug' })
    expect(getAgentRowConversationName(tab, 'claude', true)).toBe('Run tests')
  })

  it('keeps OpenCode semantic session titles whole', () => {
    const tab = makeTab({ title: 'OC | build the release pipeline' })
    expect(getAgentRowConversationName(tab, 'opencode', false)).toBe(
      'OC | build the release pipeline'
    )
  })

  it.each([
    ['codex', true],
    ['codex', false],
    ['claude', true],
    ['claude', false]
  ] as const)('uses the saved %s conversation title with generated titles %s', (agent, enabled) => {
    const tab = makeTab({
      aiVaultTitle: { agent, sessionId: 'saved-session', title: '  Slack intake reliability  ' },
      generatedTitle: 'Generated fallback',
      title: 'Codex ready'
    })
    expect(getAgentRowConversationName(tab, agent, enabled)).toBe('Slack intake reliability')
  })

  it.each([
    [{ customTitle: 'Manual rename' }, 'Manual rename'],
    [{ quickCommandLabel: 'Run tests' }, 'Run tests'],
    [{ title: 'OC | native session name' }, 'OC | native session name']
  ] as const)(
    'keeps explicit and OpenCode titles ahead of saved conversation titles: %s',
    (override, expected) => {
      const tab = makeTab({
        aiVaultTitle: { agent: 'codex', sessionId: 'saved-session', title: 'Saved conversation' },
        generatedTitle: 'Generated fallback',
        title: 'Codex ready',
        ...override
      })
      expect(getAgentRowConversationName(tab, 'codex', true)).toBe(expected)
    }
  )

  it('falls through a blank saved title to generated and live titles', () => {
    const tab = makeTab({
      aiVaultTitle: { agent: 'codex', sessionId: 'saved-session', title: '   ' },
      generatedTitle: 'Generated fallback',
      title: 'Fix replay guard'
    })
    expect(getAgentRowConversationName(tab, 'codex', true)).toBe('Generated fallback')
    expect(getAgentRowConversationName(tab, 'codex', false)).toBe('Fix replay guard')
  })

  it('never uses a tab saved-session name for split-pane rows', () => {
    const tab = makeTab({
      aiVaultTitle: { agent: 'codex', sessionId: 'focused-session', title: 'Focused conversation' },
      title: 'Focused live title'
    })
    expect(getAgentRowConversationName(tab, 'codex', true, 'Sibling conversation')).toBe(
      'Sibling conversation'
    )
    expect(getAgentRowConversationName(tab, 'codex', true, null)).toBeNull()
    expect(getAgentRowConversationName(tab, 'codex', false, '')).toBeNull()
    expect(getAgentRowConversationName(tab, 'codex', true, undefined)).toBe('Focused conversation')
  })

  it('preserves generated tab names when suppressing saved split-pane session names', () => {
    const tab = makeTab({
      aiVaultTitle: { agent: 'codex', sessionId: 'focused-session', title: 'Focused conversation' },
      generatedTitle: 'Shared generated name',
      title: 'Focused live title'
    })
    expect(getAgentRowConversationName(tab, 'codex', true, 'Sibling conversation')).toBe(
      'Shared generated name'
    )
    expect(getAgentRowConversationName(tab, 'codex', true, null)).toBe('Shared generated name')
    expect(getAgentRowConversationName(tab, 'codex', false, 'Sibling conversation')).toBe(
      'Sibling conversation'
    )
    expect(getAgentRowConversationName(tab, 'codex', false, null)).toBeNull()
  })

  it('uses the generated title only when generated titles are enabled', () => {
    const tab = makeTab({ generatedTitle: 'Fix intake flow', title: '✳ Investigate replay bug' })
    expect(getAgentRowConversationName(tab, 'claude', true)).toBe('Fix intake flow')
    expect(getAgentRowConversationName(tab, 'claude', false)).toBe('Investigate replay bug')
  })

  it('names a split pane from its own live title, not the tab title', () => {
    // Why: the tab title is the FOCUSED pane's, so the sibling must not read it.
    const tab = makeTab({ title: '\u2733 Linear work log' })
    expect(getAgentRowConversationName(tab, 'claude', false, '\u2733 Redis cache strategy')).toBe(
      'Redis cache strategy'
    )
    // OpenCode's semantic title is a live title too, so it follows the pane.
    expect(
      getAgentRowConversationName(tab, 'opencode', false, 'OC | build the release pipeline')
    ).toBe('OC | build the release pipeline')
    // No resolvable pane title: no live title at all, never the sibling's.
    expect(getAgentRowConversationName(tab, 'claude', false, null)).toBeNull()
    // A single-pane tab passes undefined and is untouched.
    expect(getAgentRowConversationName(tab, 'claude', false)).toBe('Linear work log')
  })

  it('keeps tab-owned names above the pane title', () => {
    // Why: the user gave these to the whole tab, and none of them flip on focus.
    const custom = makeTab({ customTitle: 'Patient sync spike' })
    expect(getAgentRowConversationName(custom, 'claude', false, 'Redis cache strategy')).toBe(
      'Patient sync spike'
    )
    const quick = makeTab({ quickCommandLabel: 'Run tests' })
    expect(getAgentRowConversationName(quick, 'claude', false, null)).toBe('Run tests')
    const generated = makeTab({ generatedTitle: 'Fix intake flow' })
    expect(getAgentRowConversationName(generated, 'claude', true, null)).toBe('Fix intake flow')
  })

  it('strips leading status decoration from agent-set titles', () => {
    expect(
      getAgentRowConversationName(makeTab({ title: '✳ Fix patient intake flow' }), 'claude', false)
    ).toBe('Fix patient intake flow')
    expect(
      getAgentRowConversationName(makeTab({ title: '⠋ Refactor replay guard' }), 'codex', false)
    ).toBe('Refactor replay guard')
  })

  it('rejects spinner+cwd titles instead of surfacing paths as names', () => {
    expect(
      getAgentRowConversationName(makeTab({ title: '⠋ ~/orca/workspaces' }), 'codex', false)
    ).toBeNull()
    expect(
      getAgentRowConversationName(makeTab({ title: '/Users/dev/repo' }), 'codex', false)
    ).toBeNull()
    expect(
      getAgentRowConversationName(makeTab({ title: 'C:\\repos\\orca' }), 'codex', false)
    ).toBeNull()
    expect(
      getAgentRowConversationName(makeTab({ title: 'orca/workspaces' }), 'codex', false)
    ).toBeNull()
    expect(
      getAgentRowConversationName(
        makeTab({ title: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\orca' }),
        'codex',
        false
      )
    ).toBeNull()
    expect(
      getAgentRowConversationName(makeTab({ title: 'repos\\orca' }), 'codex', false)
    ).toBeNull()
  })

  it('accepts multi-word titles that merely contain a slash', () => {
    expect(
      getAgentRowConversationName(makeTab({ title: 'Fix a/b toggle in settings' }), 'codex', false)
    ).toBe('Fix a/b toggle in settings')
  })

  it('rejects synthetic status titles', () => {
    expect(
      getAgentRowConversationName(makeTab({ title: 'Codex ready' }), 'codex', false)
    ).toBeNull()
    expect(
      getAgentRowConversationName(makeTab({ title: 'Codex - action required' }), 'codex', false)
    ).toBeNull()
    expect(
      getAgentRowConversationName(makeTab({ title: 'Cursor Agent' }), 'cursor', false)
    ).toBeNull()
  })

  it('rejects identity-echo, management, and placeholder titles', () => {
    expect(getAgentRowConversationName(makeTab({ title: 'Claude' }), 'claude', false)).toBeNull()
    expect(
      getAgentRowConversationName(makeTab({ title: '✳ Claude Code' }), 'claude', false)
    ).toBeNull()
    expect(
      getAgentRowConversationName(
        makeTab({ title: 'Claude Code - action required' }),
        'claude',
        false
      )
    ).toBeNull()
    expect(
      getAgentRowConversationName(makeTab({ title: '✦ Gemini CLI' }), 'gemini', false)
    ).toBeNull()
    expect(
      getAgentRowConversationName(makeTab({ title: '◇ Ready (orca)' }), 'gemini', false)
    ).toBeNull()
    expect(
      getAgentRowConversationName(makeTab({ title: 'claude agents' }), 'claude', false)
    ).toBeNull()
    expect(getAgentRowConversationName(makeTab({ title: 'Agent' }), 'claude', false)).toBeNull()
  })

  it('rejects empty, glyph-only, and default terminal titles', () => {
    expect(getAgentRowConversationName(makeTab(), 'claude', false)).toBeNull()
    expect(getAgentRowConversationName(makeTab({ title: '✳' }), 'claude', false)).toBeNull()
    expect(
      getAgentRowConversationName(makeTab({ title: 'Terminal 1' }), 'claude', false)
    ).toBeNull()
    expect(
      getAgentRowConversationName(
        makeTab({ title: 'Terminal 2', defaultTitle: 'Terminal 2' }),
        'claude',
        false
      )
    ).toBeNull()
  })
})
