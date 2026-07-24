import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../../../shared/types'
import { AGENT_CATALOG, AgentIcon } from '@/lib/agent-catalog'
import { AGENT_FAVICON_ASSETS } from '@/lib/agent-favicon-assets'
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

  it('supports an Agent-only empty state without presenting a blank terminal', () => {
    const markup = renderToStaticMarkup(
      <AgentCombobox
        agents={[]}
        value={null}
        onValueChange={vi.fn()}
        allowBlankTerminal={false}
        emptyLabel="Select an Agent"
      />
    )

    expect(markup).toContain('Select an Agent')
    expect(markup).not.toContain('Blank Terminal')
  })

  it('uses the bundled OpenClaude favicon crop instead of Claude or GitHub artwork', () => {
    const markup = renderToStaticMarkup(<AgentIcon agent="openclaude" />)

    expect(markup).toContain('/resources/openclaude-logo.png')
    expect(markup).toContain('<img')
    expect(markup).not.toContain('https://github.com/Gitlawb.png')
    expect(markup).not.toContain('<svg')
  })

  it('uses the official OpenCode SVG mark instead of a remote favicon', () => {
    const markup = renderToStaticMarkup(<AgentIcon agent="opencode" />)

    expect(markup).toContain('<svg')
    expect(markup).toContain('viewBox="0 0 512 512"')
    expect(markup).not.toContain('/resources/opencode.webp')
    expect(markup).not.toContain('https://www.google.com/s2/favicons')
    expect(markup).not.toContain('<img')
  })

  it('renders bundled favicons for favicon-domain agents instead of the remote Google service', () => {
    // Why: previously loaded from Google's favicon service (#8451). Iterate the
    // full asset map so missing files/key mismatches fail the test.
    for (const agent of Object.keys(AGENT_FAVICON_ASSETS) as TuiAgent[]) {
      const markup = renderToStaticMarkup(<AgentIcon agent={agent} />)
      expect(markup).toContain(`/shared/agent-icons/${agent}.png`)
      expect(markup).not.toContain('https://www.google.com/s2/favicons')
    }
  })
})
