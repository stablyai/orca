/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CompactAgentRow } from './worktree-card-compact-agent-row'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only global flag React reads to allow act() outside its type declarations.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/dashboard/use-agent-row-conversation-name', () => ({
  useAgentRowConversationName: () => null
}))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownForPane: () => null
}))

function makeAgent({
  stateStartedAt = 1000,
  state = 'done'
}: {
  stateStartedAt?: number
  state?: string
} = {}): DashboardAgentRowData {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture only needs the fields CompactAgentRow reads.
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

// Why: the leading-text span is the row's only visual signal that a finished
// agent hasn't been visited yet; find it the same way the component nests it
// (min-w-0/flex-1/truncate wraps it, its first child is the emphasis target).
function leadingTextSpan(container: HTMLElement): Element | null | undefined {
  return container.querySelector('.min-w-0.flex-1.truncate')?.firstElementChild
}

function renderRow(agent: DashboardAgentRowData, isUnvisited: boolean): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <TooltipProvider>
        <CompactAgentRow agent={agent} now={2000} onActivate={() => {}} isUnvisited={isUnvisited} />
      </TooltipProvider>
    )
  })
  return container
}

describe('CompactAgentRow unvisited emphasis', () => {
  it('emphasizes the leading text for a finished agent the user has not visited', () => {
    const container = renderRow(makeAgent(), true)
    const span = leadingTextSpan(container)
    expect(span).toBeTruthy()
    expect(span?.className).not.toContain('text-muted-foreground')
    expect(span?.className).toContain('text-foreground')
  })

  it('keeps the leading text muted once the agent has been visited', () => {
    const container = renderRow(makeAgent(), false)
    const span = leadingTextSpan(container)
    expect(span).toBeTruthy()
    expect(span?.className).toContain('text-muted-foreground')
  })
})
