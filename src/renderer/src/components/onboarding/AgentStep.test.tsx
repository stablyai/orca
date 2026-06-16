import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { AgentStep } from './AgentStep'
import { TooltipProvider } from '@/components/ui/tooltip'

describe('AgentStep', () => {
  it('shows the collapsed fallback agents summary', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <AgentStep
          selectedAgent={null}
          onSelect={vi.fn()}
          detectedSet={new Set([AGENT_CATALOG[0].id])}
          isDetecting={false}
          yoloPermissions
          onYoloPermissionsChange={vi.fn()}
        />
      </TooltipProvider>
    )

    expect(html).toContain(`Show ${AGENT_CATALOG.length - 1} more agents→`)
    expect(html).toContain('data-agent-grid-scroll')
    expect(html).toContain('data-slot="checkbox"')
    expect(html).toContain('Yolo / Dangerously skip permissions')
    expect(html).not.toContain('role="radiogroup"')
  })

  it('labels the fallback agents summary as hide when expanded', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <AgentStep
          selectedAgent={AGENT_CATALOG[1].id}
          onSelect={vi.fn()}
          detectedSet={new Set([AGENT_CATALOG[0].id])}
          isDetecting={false}
          yoloPermissions
          onYoloPermissionsChange={vi.fn()}
        />
      </TooltipProvider>
    )

    expect(html).toContain('Hide agents')
    expect(html).not.toContain(`Show ${AGENT_CATALOG.length - 1} more agents→`)
  })
})
