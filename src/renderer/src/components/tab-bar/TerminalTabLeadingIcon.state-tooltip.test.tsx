import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const agentDotMock = vi.hoisted(() => vi.fn((_props: Record<string, unknown>) => null))

vi.mock('@/components/AgentStateDot', () => ({
  AgentStateDot: (props: Record<string, unknown>) => {
    agentDotMock(props)
    return null
  }
}))

import { TerminalTabLeadingIcon } from './TerminalTabLeadingIcon'

describe('TerminalTabLeadingIcon agent-state glyph', () => {
  it('renders the state glyph without a hover tooltip', () => {
    renderToStaticMarkup(
      <TerminalTabLeadingIcon
        agent="claude"
        activityStatus="working"
        shell={undefined}
        showUnreadActivity={false}
        isActive
      />
    )

    expect(agentDotMock).toHaveBeenCalledWith(expect.objectContaining({ title: null }))
  })
})
