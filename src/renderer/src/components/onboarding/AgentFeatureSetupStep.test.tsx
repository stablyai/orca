import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentFeatureSetupStep } from './AgentFeatureSetupStep'

describe('AgentFeatureSetupStep', () => {
  it('renders the agent feature setup checklist', () => {
    const html = renderToStaticMarkup(
      <AgentFeatureSetupStep
        featureSetup={{
          browserUse: true,
          computerUse: true,
          orchestration: true,
          linearTickets: false
        }}
        onFeatureSetupChange={vi.fn()}
        featureSetupCommand={null}
        featureSetupCommandSelection={null}
        setupBusyLabel={null}
        onStartFeatureSetup={vi.fn()}
      />
    )

    expect(html).toContain('Agent Browser Use')
    expect(html).toContain('Computer Use')
    expect(html).toContain('Agent Orchestration')
    expect(html).toContain('Linear agent skill')
    expect(html).toContain('Enable capabilities')
    expect(html).toContain('role="checkbox"')
  })
})
