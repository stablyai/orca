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

  it('uses the generated title only when generated titles are enabled', () => {
    const tab = makeTab({ generatedTitle: 'Fix intake flow', title: '✳ Investigate replay bug' })
    expect(getAgentRowConversationName(tab, 'claude', true)).toBe('Fix intake flow')
    expect(getAgentRowConversationName(tab, 'claude', false)).toBe('Investigate replay bug')
  })

  it('drops the live title in a split tab, where it names only the focused pane', () => {
    const tab = makeTab({ title: '✳ Investigate replay bug' })
    expect(getAgentRowConversationName(tab, 'claude', false)).toBe('Investigate replay bug')
    expect(getAgentRowConversationName(tab, 'claude', false, true)).toBeNull()
    // OpenCode semantic titles are live titles too, so they go with it.
    const openCodeTab = makeTab({ title: 'OC | build the release pipeline' })
    expect(getAgentRowConversationName(openCodeTab, 'opencode', false, true)).toBeNull()
  })

  it('keeps tab-owned names in a split tab', () => {
    // Why: the user gave these to the whole tab, so every pane in it may show them.
    expect(
      getAgentRowConversationName(
        makeTab({ customTitle: 'Patient sync spike' }),
        'claude',
        false,
        true
      )
    ).toBe('Patient sync spike')
    expect(
      getAgentRowConversationName(
        makeTab({ quickCommandLabel: 'Run tests' }),
        'claude',
        false,
        true
      )
    ).toBe('Run tests')
    expect(
      getAgentRowConversationName(
        makeTab({ generatedTitle: 'Fix intake flow' }),
        'claude',
        true,
        true
      )
    ).toBe('Fix intake flow')
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
