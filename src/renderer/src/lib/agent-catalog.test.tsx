import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentIcon, getAgentCatalog } from './agent-catalog'

describe('agent catalog', () => {
  it('packages the Hermes icon with the app', () => {
    const hermes = getAgentCatalog().find((entry) => entry.id === 'hermes')

    expect(hermes?.iconUrl).toContain('hermes.png')
    expect(hermes?.faviconDomain).toBeUndefined()
    expect(renderToStaticMarkup(<AgentIcon agent="hermes" />)).toContain('hermes.png')
  })
})
