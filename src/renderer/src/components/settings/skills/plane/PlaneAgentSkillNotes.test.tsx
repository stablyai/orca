import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PlaneAgentSkillNotes } from './PlaneAgentSkillNotes'

describe('PlaneAgentSkillNotes', () => {
  it('renders titled note cards instead of a dense bullet list', () => {
    const markup = renderToStaticMarkup(<PlaneAgentSkillNotes />)

    expect(markup).toContain('Good to know')
    expect(markup).toContain('Start from a Plane issue')
    expect(markup).toContain('Mention /orca-plane')
    expect(markup).toContain('Cloud and Self-Hosted')
    expect(markup).toContain('Hiding ≠ disconnect')
    expect(markup).not.toContain('<ul')
  })
})
