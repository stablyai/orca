import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DashboardAgentHoverCardContent } from './DashboardAgentHoverCardContent'
import type { DashboardAgentRow } from './useDashboardData'

function makeAgentRow(): DashboardAgentRow {
  const now = Date.UTC(2026, 4, 20)
  const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
  const prompt = 'Review **markdown** formatting'

  return {
    paneKey,
    agentType: 'codex',
    state: 'working',
    startedAt: now - 60_000,
    tab: {
      id: 'tab-1',
      ptyId: null,
      worktreeId: 'wt-1',
      title: 'Codex',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: now
    },
    entry: {
      state: 'working',
      prompt,
      updatedAt: now,
      stateStartedAt: now - 60_000,
      agentType: 'codex',
      paneKey,
      stateHistory: [{ state: 'working', prompt, startedAt: now - 60_000 }],
      toolName: 'Bash',
      toolInput: 'pnpm test',
      lastAssistantMessage: 'Rendered **markdown** in the hover card.'
    }
  }
}

describe('DashboardAgentHoverCardContent', () => {
  it('renders prompt and assistant markdown in structured sections', () => {
    const markup = renderToStaticMarkup(
      <DashboardAgentHoverCardContent
        agent={makeAgentRow()}
        dotState="working"
        prompt="Review **markdown** formatting"
        isWorking
        toolName="Bash"
        toolInput="pnpm test"
        lastAssistantMessage="Rendered **markdown** in the hover card."
        tsParts={['started 1m ago']}
      />
    )

    expect(markup).toContain('Prompt')
    expect(markup).toContain('Current tool')
    expect(markup).toContain('Latest message')
    expect(markup).toContain('<strong>markdown</strong>')
    expect(markup).toContain('pnpm test')
  })
})
