import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AGENT_CATALOG, AgentIcon } from '@/lib/agent-catalog'
import AgentCombobox from './AgentCombobox'

describe('AgentCombobox', () => {
  it('keeps enough trigger width for GitHub Copilot when callers pass min-w-0', () => {
    const markup = renderToStaticMarkup(
      <AgentCombobox
        agents={AGENT_CATALOG}
        value="copilot"
        onValueChange={vi.fn()}
        triggerClassName="h-9 w-full min-w-0"
      />
    )

    expect(markup).toContain('GitHub Copilot')
    expect(markup).toContain('!min-w-[260px]')
    expect(markup).toContain('flex-1')
  })

  it('uses the bundled OpenClaude favicon crop instead of Claude or GitHub artwork', () => {
    const markup = renderToStaticMarkup(<AgentIcon agent="openclaude" />)

    expect(markup).toContain('/resources/openclaude-logo.png')
    expect(markup).toContain('<img')
    expect(markup).not.toContain('https://github.com/Gitlawb.png')
    expect(markup).not.toContain('<svg')
  })
})
