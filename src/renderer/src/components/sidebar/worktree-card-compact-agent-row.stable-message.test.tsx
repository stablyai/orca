/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CompactAgentRow } from './worktree-card-compact-agent-row'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/dashboard/use-agent-row-conversation-name', () => ({
  useAgentRowConversationName: () => null
}))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownForPane: () => null
}))

function makeAgent({
  stateStartedAt,
  lastAssistantMessage,
  state = 'working'
}: {
  stateStartedAt: number
  lastAssistantMessage?: string
  state?: string
}): DashboardAgentRowData {
  return {
    paneKey: 'tab-1:leaf-1',
    tab: { id: 'tab-1' },
    agentType: 'claude',
    state,
    startedAt: 500,
    entry: {
      prompt: 'do the task',
      state,
      stateStartedAt,
      lastAssistantMessage,
      paneKey: 'tab-1:leaf-1',
      updatedAt: stateStartedAt
    }
  } as unknown as DashboardAgentRowData
}

let root: Root | undefined

afterEach(() => {
  act(() => root?.unmount())
  document.body.replaceChildren()
})

function renderRow(agent: DashboardAgentRowData): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <TooltipProvider>
        <CompactAgentRow agent={agent} now={2000} onActivate={() => {}} />
      </TooltipProvider>
    )
  })
  return container
}

function rerenderRow(agent: DashboardAgentRowData): void {
  act(() => {
    root!.render(
      <TooltipProvider>
        <CompactAgentRow agent={agent} now={2000} onActivate={() => {}} />
      </TooltipProvider>
    )
  })
}

describe('CompactAgentRow stable assistant message', () => {
  it('holds the last assistant line when a same-turn ping omits it', () => {
    const container = renderRow(
      makeAgent({ stateStartedAt: 1000, lastAssistantMessage: 'First reply' })
    )
    expect(container.textContent).toContain('First reply')

    rerenderRow(makeAgent({ stateStartedAt: 1000 }))
    expect(container.textContent).toContain('First reply')
  })

  it('drops the held line when a new turn starts', () => {
    const container = renderRow(
      makeAgent({ stateStartedAt: 1000, lastAssistantMessage: 'First reply' })
    )
    rerenderRow(makeAgent({ stateStartedAt: 3000 }))
    expect(container.textContent).not.toContain('First reply')
  })

  it('never holds across pings for entries without a turn identity (stateStartedAt 0)', () => {
    const container = renderRow(makeAgent({ stateStartedAt: 0, lastAssistantMessage: 'Turn one' }))
    expect(container.textContent).toContain('Turn one')

    rerenderRow(makeAgent({ stateStartedAt: 0 }))
    expect(container.textContent).not.toContain('Turn one')
  })

  it('drops the held line when the agent leaves working', () => {
    const container = renderRow(
      makeAgent({ stateStartedAt: 1000, lastAssistantMessage: 'First reply' })
    )
    rerenderRow(makeAgent({ stateStartedAt: 1000, state: 'done' }))
    rerenderRow(makeAgent({ stateStartedAt: 1000, state: 'working' }))
    expect(container.textContent).not.toContain('First reply')
  })
})
