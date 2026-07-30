import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LinearAgentSkillNotes } from './LinearAgentSkillNotes'

describe('LinearAgentSkillNotes', () => {
  it('renders titled note cards instead of a dense bullet list', () => {
    const markup = renderToStaticMarkup(<LinearAgentSkillNotes />)

    expect(markup).toContain('Good to know')
    expect(markup).toContain('Start from a Linear issue')
    expect(markup).toContain('Mention /orca-linear')
    expect(markup).toContain('Keys follow the runtime')
    expect(markup).toContain('Hiding ≠ disconnect')
    expect(markup).not.toContain('<ul')
  })
})
