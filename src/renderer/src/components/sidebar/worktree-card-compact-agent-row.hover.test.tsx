/** @vitest-environment happy-dom */
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { CompactAgentRow } from './worktree-card-compact-agent-row'

const NOW = 120_000
const ASSISTANT_MESSAGE = '**Sobre o dry-run**\n\nIsso ja funciona, nao precisa mexer no dry-run.'

vi.mock('@/components/dashboard/use-agent-row-conversation-name', () => ({
  useAgentRowConversationName: () => null
}))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownForPane: () => null
}))

vi.mock('./comment-markdown-lazy', () => ({
  CommentMarkdownAsync: ({ content }: { content: string }) => (
    <div data-agent-hover-markdown="">{content}</div>
  ),
  preloadCommentMarkdown: () => {}
}))

// Radix opens the card on real pointer timing, which no renderer test drives; the
// repo's hover-card tests render the content inline instead.
vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  HoverCardTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  HoverCardContent: ({ children }: { children: ReactNode }) => (
    <div data-agent-hover-card="">{children}</div>
  )
}))

function makeAgent(entryOverrides: Partial<AgentStatusEntry> = {}): DashboardAgentRowData {
  const paneKey = 'tab-1:leaf-1'
  const tab: TerminalTab = {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  const entry: AgentStatusEntry = {
    state: 'working',
    prompt: 'MIA-1051 dry-run acordo no after-service',
    updatedAt: 60_000,
    stateStartedAt: 60_000,
    agentType: 'claude',
    paneKey,
    stateHistory: [],
    model: 'Fable 5.1',
    lastAssistantMessage: ASSISTANT_MESSAGE,
    ...entryOverrides
  }

  return {
    paneKey,
    entry,
    tab,
    agentType: entry.agentType ?? 'claude',
    state: entry.state,
    startedAt: entry.stateStartedAt
  }
}

function renderRow(
  sendTargetStatus?: 'eligible',
  entryOverrides: Partial<AgentStatusEntry> = {}
): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(
    <TooltipProvider>
      <CompactAgentRow
        agent={makeAgent(entryOverrides)}
        now={NOW}
        onActivate={vi.fn()}
        sendTargetStatus={sendTargetStatus}
        sendTargetDisabledReason={sendTargetStatus ? 'Busy' : undefined}
      />
    </TooltipProvider>
  )
  return host
}

function titleAttributes(host: HTMLElement): string[] {
  return [...host.querySelectorAll('[title]')].map((el) => el.getAttribute('title') ?? '')
}

describe('CompactAgentRow hover preview', () => {
  it('keeps the assistant message and model out of native title attributes', () => {
    const titles = titleAttributes(renderRow())
    expect(titles.some((title) => title.includes('Isso ja funciona'))).toBe(false)
    expect(titles).not.toContain('Fable 5.1')
  })

  it('renders prompt, assistant message, state and model in the hover card', () => {
    const card = renderRow().querySelector('[data-agent-hover-card]')
    const text = card?.textContent ?? ''
    expect(text).toContain('MIA-1051 dry-run acordo no after-service')
    expect(text).toContain('Isso ja funciona')
    expect(text).toContain('Working')
    expect(text).toContain('Fable 5.1')
  })

  it('renders a tool preview as plain text instead of markdown', () => {
    const host = renderRow(undefined, {
      lastAssistantMessage: undefined,
      toolName: 'Bash',
      toolInput: 'rg -n "**/*.ts"'
    })
    const card = host.querySelector('[data-agent-hover-card]')
    expect(card?.textContent).toContain('**/*.ts')
    expect(card?.querySelector('[data-agent-hover-markdown]')).toBeNull()
  })

  it('renders the assistant reply as markdown', () => {
    const card = renderRow().querySelector('[data-agent-hover-card]')
    expect(card?.querySelector('[data-agent-hover-markdown]')).not.toBeNull()
  })

  it('drops the hover card in send-target mode so the disabled reason stays alone', () => {
    const host = renderRow('eligible')
    expect(host.querySelector('[data-agent-hover-card]')).toBeNull()
    expect(titleAttributes(host)).toContain('Busy')
  })
})
