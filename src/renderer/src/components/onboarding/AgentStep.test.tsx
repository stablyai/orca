import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { AgentStep } from './AgentStep'

describe('AgentStep', () => {
  it('shows the collapsed fallback agents summary', () => {
    const html = renderToStaticMarkup(
      <AgentStep
        selectedAgent={null}
        onSelect={vi.fn()}
        detectedSet={new Set([AGENT_CATALOG[0].id])}
        isDetecting={false}
      />
    )

    expect(html).toContain(`Show ${AGENT_CATALOG.length - 1} more agents→`)
  })

  it('labels the fallback agents summary as hide when expanded', () => {
    const html = renderToStaticMarkup(
      <AgentStep
        selectedAgent={AGENT_CATALOG[1].id}
        onSelect={vi.fn()}
        detectedSet={new Set([AGENT_CATALOG[0].id])}
        isDetecting={false}
      />
    )

    expect(html).toContain('Hide agents')
    expect(html).not.toContain(`Show ${AGENT_CATALOG.length - 1} more agents→`)
  })
})
