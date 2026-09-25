/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CompactAgentRow } from './worktree-card-compact-agent-row'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

vi.mock('@/components/dashboard/use-agent-row-conversation-name', () => ({
  useAgentRowConversationName: () => null
}))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownForPane: () => null
}))

function makeAgent(state: 'done' | 'working' = 'done'): DashboardAgentRowData {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture carries only the fields CompactAgentRow reads.
  return {
    paneKey: 'tab-1:leaf-1',
    tab: { id: 'tab-1' },
    agentType: 'claude',
    state,
    startedAt: 500,
    entry: {
      prompt: 'do the task',
      state,
      stateStartedAt: 1000,
      lastAssistantMessage: 'Finished',
      paneKey: 'tab-1:leaf-1',
      updatedAt: 1000
    }
  } as unknown as DashboardAgentRowData
}

let root: Root | undefined

afterEach(() => {
  act(() => root?.unmount())
  document.body.replaceChildren()
})

function renderRow(isUnvisited: boolean, state: 'done' | 'working' = 'done'): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <TooltipProvider>
        <CompactAgentRow
          agent={makeAgent(state)}
          now={2000}
          onActivate={() => {}}
          isUnvisited={isUnvisited}
        />
      </TooltipProvider>
    )
  })
  return container
}

function leadingText(container: HTMLElement): HTMLElement {
  const leading = [...container.querySelectorAll('span')].find(
    (span) => span.textContent === 'do the task'
  )
  if (!leading) {
    throw new Error('leading text span not rendered')
  }
  return leading
}

describe('CompactAgentRow unvisited emphasis', () => {
  it('bolds a finished row the user has not visited yet', () => {
    const container = renderRow(true)
    const leading = leadingText(container)
    expect(container.querySelector('[data-agent-row-unread-alert]')).not.toBeNull()
    expect(leading.className).toContain('font-semibold')
    expect(leading.className).toContain('text-foreground')
  })

  it('keeps a working row bold but without the badge', () => {
    const container = renderRow(true, 'working')
    expect(container.querySelector('[data-agent-row-unread-alert]')).toBeNull()
    expect(leadingText(container).className).toContain('font-semibold')
  })

  it('keeps a visited row muted', () => {
    const container = renderRow(false)
    const leading = leadingText(container)
    expect(container.querySelector('[data-agent-row-unread-alert]')).toBeNull()
    expect(leading.className).not.toContain('font-semibold')
  })
})
