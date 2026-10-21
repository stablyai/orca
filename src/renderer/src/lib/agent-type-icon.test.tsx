import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentTypeIcon } from './agent-type-icon'

function render(agentType: string | null | undefined): string {
  return renderToStaticMarkup(<AgentTypeIcon agentType={agentType} />)
}

describe('AgentTypeIcon', () => {
  it("renders a program's first letter", () => {
    expect(render('brew')).toContain('>B</text>')
    expect(render('terraform')).toContain('>T</text>')
  })

  it('skips leading punctuation the app id grammar allows', () => {
    expect(render('_9tool')).toContain('>9</text>')
    expect(render('.+-')).toContain('>?</text>')
  })

  it('keeps "?" for unidentified agents', () => {
    expect(render('unknown')).toContain('>?</text>')
    expect(render(null)).toContain('>?</text>')
    expect(render(undefined)).toContain('>?</text>')
  })

  it('still renders the Claude icon for known agents', () => {
    expect(render('claude')).toContain('#D97757')
  })
})
