import { describe, expect, it } from 'vitest'
import { getAgentLabel } from './agent-title-identity'
import { collectAgentTitleEvidence } from './agent-title-evidence'
import { isDshTerminalTitle } from './dsh-terminal-title'
import { resolvePublishedPaneAgentIdentity } from './published-pane-agent-identity'
import { resolveExplicitTerminalTitleAgentType } from './terminal-title-agent-type'

describe('Codewhale terminal titles', () => {
  it('recognizes its name and the whale plus activity-verb frames', () => {
    expect(getAgentLabel('codewhale')).toBe('Codewhale')
    expect(getAgentLabel('🐳 working…')).toBe('Codewhale')
    expect(getAgentLabel('🐋 reasoning…')).toBe('Codewhale')
    expect(getAgentLabel('zsh | 🐳 using tool…')).toBe('Codewhale')
    expect(resolveExplicitTerminalTitleAgentType('🐳 working…')).toBe('codewhale')
    expect(resolveExplicitTerminalTitleAgentType('codewhale')).toBe('codewhale')
  })

  it('leaves a DSH session title with the shared animated whale to DSH', () => {
    expect(isDshTerminalTitle('🐋 reasoning…')).toBe(false)
    expect(isDshTerminalTitle('✦ 🐋 Review codewhale integration')).toBe(true)
    expect(getAgentLabel('✦ 🐋 Review codewhale integration')).not.toBe('Codewhale')
    expect(resolveExplicitTerminalTitleAgentType('✦ 🐋 Review codewhale integration')).toBe('dsh')
  })

  it('publishes a hand-started pane from its title alone', () => {
    expect(collectAgentTitleEvidence('codewhale').agent).toBe('codewhale')
    expect(collectAgentTitleEvidence('zsh | 🐳 working…').agent).toBe('codewhale')
    expect(resolvePublishedPaneAgentIdentity({ title: 'codewhale' })).toBe('codewhale')
    expect(resolvePublishedPaneAgentIdentity({ title: '🐋 reasoning…' })).toBe('codewhale')
  })

  it('keeps the configured title prefix on its resting name', () => {
    expect(getAgentLabel('[project] codewhale')).toBe('Codewhale')
    expect(resolveExplicitTerminalTitleAgentType('[project] codewhale')).toBe('codewhale')
    expect(resolvePublishedPaneAgentIdentity({ title: '[project] codewhale' })).toBe('codewhale')
    expect(collectAgentTitleEvidence('[project] Review codewhale').agent).toBeNull()
  })

  it('does not claim a name that is payload after a DSH or task header', () => {
    expect(isDshTerminalTitle('✦ 🐋 Review | codewhale')).toBe(true)
    expect(getAgentLabel('✦ 🐋 Review | codewhale')).not.toBe('Codewhale')
    expect(resolveExplicitTerminalTitleAgentType('✦ 🐋 Review | codewhale')).toBe('dsh')
    expect(collectAgentTitleEvidence('✦ 🐋 Review | codewhale').agent).not.toBe('codewhale')
    expect(collectAgentTitleEvidence('fix: login | codewhale').agent).toBeNull()
  })
})
