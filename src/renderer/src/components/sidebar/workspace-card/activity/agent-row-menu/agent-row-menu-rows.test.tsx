// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import DashboardAgentRow from '@/components/dashboard/DashboardAgentRow'
import type { DashboardAgentRow as AgentRowData } from '@/components/dashboard/rows/dashboard-agent-row'
import type { AgentStatusEntry } from '../../../../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalTab } from '../../../../../../../shared/workspace-layout/terminal-tab-types'
import { CompactAgentRow } from '../worktree-card-compact-agent-row'
import { buildTitleDerivedAgentRows } from '../worktree-title-derived-agent-rows'
import { CompactAgentExpansion } from '../worktree-card-compact-agents'

// Fixed, so no test reads the wall clock.
const now = 1_792_983_600_000
const paneKey = 'agent-tab:1'
const tab: TerminalTab = {
  id: 'agent-tab',
  ptyId: null,
  worktreeId: 'rows-workspace',
  title: 'Chat',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: now
}

const TITLE_LEAF_ID = '11111111-1111-4111-8111-111111111111'

function agentRow(prompt = 'Compare the payment channels', rowTab = tab): AgentRowData {
  const entry: AgentStatusEntry = {
    paneKey,
    worktreeId: 'rows-workspace',
    agentType: 'codex',
    state: 'done',
    prompt,
    updatedAt: now,
    stateStartedAt: now,
    stateHistory: []
  }
  return {
    paneKey,
    entry,
    tab: rowTab,
    agentType: 'codex',
    rowSource: 'live',
    state: 'done',
    startedAt: now
  }
}

type RowProps = {
  agent: AgentRowData
  onActivate: (tabId: string, paneKey: string) => void
  sendTargetStatus?: 'eligible' | 'disabled'
  onSendTargetClick?: (paneKey: string) => void
}

const renderers = {
  compact: (props: RowProps) => <CompactAgentRow now={now} {...props} />,
  full: (props: RowProps) => <DashboardAgentRow now={now} onDismiss={() => {}} {...props} />
}

function renderRow(mode: keyof typeof renderers, props: RowProps): HTMLElement {
  const Row = renderers[mode]
  const { container } = render(
    <TooltipProvider>
      <Row {...props} />
    </TooltipProvider>
  )
  const row = container.querySelector('[data-workspace-agent-row]')
  if (!(row instanceof HTMLElement)) {
    throw new Error('no agent row')
  }
  return row
}

function seedLiveTurn(): void {
  const { entry } = agentRow()
  useAppStore.setState({ agentStatusByPaneKey: acceptedAgentStatuses([[paneKey, entry]]) })
}

function openMenu(row: HTMLElement): void {
  act(() => {
    fireEvent.contextMenu(row, { clientX: 40, clientY: 10 })
  })
}

function item(label: string): HTMLElement {
  const found = screen.getAllByRole('menuitem').find((entry) => entry.textContent === label)
  if (!found) {
    throw new Error(`no ${label}`)
  }
  return found
}

function choose(label: string): void {
  const target = item(label)
  // A person clicks well after the right-click that opened the menu, outside its guard window.
  const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1_000)
  try {
    act(() => {
      fireEvent.click(target)
    })
  } finally {
    later.mockRestore()
  }
}

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe.each(['compact', 'full'] as const)('the Agent menu on a %s row', (mode) => {
  it.each(['eligible', 'disabled'] as const)(
    'never picks the row as a send target, and still opens the agent (%s)',
    (sendTargetStatus) => {
      seedLiveTurn()
      const onActivate = vi.fn()
      const onSendTargetClick = vi.fn()
      const row = renderRow(mode, {
        agent: agentRow(),
        onActivate,
        sendTargetStatus,
        onSendTargetClick
      })
      openMenu(row)
      choose('Open')
      expect(onSendTargetClick).not.toHaveBeenCalled()
      expect(onActivate).toHaveBeenCalledExactlyOnceWith('agent-tab', paneKey)
      // A click on the row itself is still a pick.
      act(() => {
        fireEvent.click(row)
      })
      expect(onSendTargetClick).toHaveBeenCalledTimes(sendTargetStatus === 'eligible' ? 1 : 0)
    }
  )

  it('offers no Mark Read or Unread on a row known only from its terminal title', () => {
    const [titleRow] = buildTitleDerivedAgentRows({
      tabs: [{ ...tab, ptyId: 'pty-1' }],
      ptyIdsByTabId: { [tab.id]: ['pty-1'] },
      runtimePaneTitlesByTabId: { [tab.id]: { 1: '✳ Claude Code' } },
      terminalLayoutsByTabId: {
        [tab.id]: {
          root: { type: 'leaf', leafId: TITLE_LEAF_ID },
          activeLeafId: TITLE_LEAF_ID,
          expandedLeafId: null
        }
      },
      seenPaneKeys: new Set(),
      now
    })
    expect(titleRow?.rowSource).toBe('live')
    const row = renderRow(mode, { agent: titleRow, onActivate: () => {} })
    openMenu(row)
    expect(screen.getAllByRole('menuitem')[2].hasAttribute('data-disabled')).toBe(true)
  })

  it('offers Mark Read or Unread on a worker row with its own live pane', () => {
    seedLiveTurn()
    const worker: AgentRowData = {
      ...agentRow(),
      lineage: {
        depth: 1,
        parentPaneKey: 'agent-tab:0',
        isFirstSibling: true,
        isLastSibling: true,
        childCount: 0
      }
    }
    const row = renderRow(mode, { agent: worker, onActivate: () => {} })
    openMenu(row)
    expect(screen.getAllByRole('menuitem')[2].hasAttribute('data-disabled')).toBe(false)
  })

  it('offers Mark Read or Unread only when the agent has a live turn to read', () => {
    const row = renderRow(mode, { agent: agentRow(), onActivate: () => {} })
    openMenu(row)
    // No live turn, as on a row known only from its terminal title.
    expect(item('Mark Unread').hasAttribute('data-disabled')).toBe(true)
    act(() => {
      seedLiveTurn()
    })
    expect(screen.getAllByRole('menuitem')[2].hasAttribute('data-disabled')).toBe(false)
  })
})

describe.each(['compact', 'full'] as const)('Copy Title on a %s row with no title', (mode) => {
  it('is disabled and leaves the clipboard alone, though the row shows a label', () => {
    const writeClipboardText = vi.fn<(text: string) => Promise<void>>(async () => {})
    const api = window.api
    Object.assign(window, { api: { ui: { writeClipboardText } } })
    try {
      seedLiveTurn()
      // No prompt and an untitled tab: nothing names the agent.
      const row = renderRow(mode, {
        agent: agentRow('', { ...tab, title: '' }),
        onActivate: () => {}
      })
      expect(row.textContent?.trim()).not.toBe('')
      openMenu(row)
      expect(item('Copy Title').hasAttribute('data-disabled')).toBe(true)
      choose('Copy Title')
      expect(writeClipboardText).not.toHaveBeenCalled()
    } finally {
      Object.assign(window, { api })
    }
  })
})

describe('an Agent menu in a collapsing agent list', () => {
  it('closes when its row is collapsed away, and stays closed when the list opens again', () => {
    seedLiveTurn()
    const agent = agentRow()
    const list = (expanded: boolean) => (
      <TooltipProvider>
        <CompactAgentExpansion expanded={expanded}>
          <CompactAgentRow now={now} agent={agent} onActivate={() => {}} />
        </CompactAgentExpansion>
      </TooltipProvider>
    )
    const { container, rerender } = render(list(true))
    const row = container.querySelector('[data-workspace-agent-row]')
    if (!(row instanceof HTMLElement)) {
      throw new Error('no agent row')
    }
    openMenu(row)
    expect(screen.getByRole('menu')).toBeTruthy()
    rerender(list(false))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(row.hasAttribute('data-agent-row-menu-open')).toBe(false)
    rerender(list(true))
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
