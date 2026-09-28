import { describe, expect, it } from 'vitest'
import { isKiroNativeTitle } from './kiro-terminal-title'
import { getAgentLabel, resolveTerminalTitleAgentType } from './terminal-title-agent-type'
import { collectAgentTitleEvidence } from './agent-title-evidence'

describe('isKiroNativeTitle', () => {
  it('matches the title the Kiro TUI actually writes', () => {
    expect(isKiroNativeTitle('kiro: ~/code/orca-mods')).toBe(true)
    expect(isKiroNativeTitle('kiro: Add usage meter to the status bar')).toBe(true)
  })

  it('matches through one wrapper segment', () => {
    expect(isKiroNativeTitle('host-1 | kiro: ~/code/orca-mods')).toBe(true)
  })

  it('does not claim a title that merely mentions kiro', () => {
    expect(isKiroNativeTitle('fix kiro: usage parser')).toBe(false)
    expect(isKiroNativeTitle('✳ investigate kiro: regressions')).toBe(false)
    // A decorated wrapper segment is another agent's own title, not an ssh/tmux label.
    expect(isKiroNativeTitle('✳ Review | kiro: usage')).toBe(false)
    expect(isKiroNativeTitle('. Review | kiro: usage')).toBe(false)
    expect(isKiroNativeTitle('kiro:')).toBe(false)
    expect(isKiroNativeTitle('')).toBe(false)
  })
})

describe('Kiro title identity', () => {
  it('labels the pane Kiro and resolves the agent id', () => {
    expect(getAgentLabel('kiro: ~/code/orca-mods')).toBe('Kiro')
    expect(resolveTerminalTitleAgentType('kiro: ~/code/orca-mods')).toBe('kiro')
  })

  it('keeps ownership when the session text names another agent', () => {
    expect(getAgentLabel('kiro: port the codex usage fetcher')).toBe('Kiro')
  })

  it('treats the marker as anchored evidence, not a free-text name', () => {
    const evidence = collectAgentTitleEvidence('kiro: ~/code/orca-mods')
    expect(evidence.agent).toBe('kiro')
    expect(evidence.anchoredNames).toContain('kiro')
  })

  it('does not read its own session text as a second owner claim', () => {
    const evidence = collectAgentTitleEvidence('kiro: fix the pager - codex')
    expect(evidence.agent).toBe('kiro')
    expect(evidence.anchoredNames).toEqual(['kiro'])
  })
})
