import { describe, expect, it } from 'vitest'
import { getAgentLabel } from './agent-title-identity'
import { isDshTerminalTitle } from './dsh-terminal-title'
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
    expect(isDshTerminalTitle('✦ 🐋 Review integration')).toBe(true)
  })
})
