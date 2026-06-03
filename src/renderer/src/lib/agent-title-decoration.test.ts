import { describe, expect, it } from 'vitest'
import { stripLeadingAgentTitleDecoration } from './agent-title-decoration'

describe('stripLeadingAgentTitleDecoration', () => {
  it("strips Claude's ✳ idle glyph", () => {
    expect(stripLeadingAgentTitleDecoration('✳ Claude Code')).toBe('Claude Code')
  })

  it("strips Claude's working/idle text prefixes", () => {
    expect(stripLeadingAgentTitleDecoration('. working on the fix')).toBe('working on the fix')
    expect(stripLeadingAgentTitleDecoration('* Claude Code')).toBe('Claude Code')
  })

  it('strips a leading braille spinner', () => {
    expect(stripLeadingAgentTitleDecoration('⠋ Pi')).toBe('Pi')
  })

  it('leaves an undecorated title untouched', () => {
    expect(stripLeadingAgentTitleDecoration('Dolphin-2')).toBe('Dolphin-2')
    expect(stripLeadingAgentTitleDecoration('npm run dev')).toBe('npm run dev')
  })

  it('keeps the original when the title is only a status glyph', () => {
    expect(stripLeadingAgentTitleDecoration('✳')).toBe('✳')
    expect(stripLeadingAgentTitleDecoration('✳ ')).toBe('✳ ')
  })
})
