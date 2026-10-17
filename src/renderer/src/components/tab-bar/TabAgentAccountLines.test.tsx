// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import { getDefaultSettings } from '../../../../shared/constants'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { ClaudeManagedAccount } from '../../../../shared/managed-account-types'
import { TabAgentAccountLines } from './TabAgentAccountLines'
import { TabHoverCard } from './TabHoverCard'
import { TAB_TOOLTIP_DELAY_MS, TabStripTooltipProvider } from './TabStripTooltipProvider'

vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))

const TAB = 'tab-1'
const LEFT = '11111111-1111-4111-8111-111111111111'
const RIGHT = '22222222-2222-4222-8222-222222222222'

function account(id: string): ClaudeManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    managedAuthPath: '/unused',
    authMethod: 'subscription-oauth',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

function row(leafId: string, accountId: string, mode: 'kept' | 'follow'): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    paneKey: makePaneKey(TAB, leafId),
    stateHistory: [],
    connectionId: null,
    runAccount: { provider: 'claude', lane: 'host', accountId, mode, shellRoute: 'account' }
  }
}

function seed(leafIds: string[]): void {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/home/user'),
      claudeManagedAccounts: [account('work'), account('personal')],
      activeClaudeManagedAccountId: 'work'
    },
    terminalLayoutsByTabId: {
      [TAB]: {
        root:
          leafIds.length === 1
            ? { type: 'leaf', leafId: leafIds[0]! }
            : {
                type: 'split',
                direction: 'vertical',
                first: { type: 'leaf', leafId: leafIds[0]! },
                second: { type: 'leaf', leafId: leafIds[1]! }
              },
        activeLeafId: leafIds[0]!,
        expandedLeafId: null
      }
    },
    agentStatusByPaneKey: Object.fromEntries(
      [row(LEFT, 'work', 'kept'), row(RIGHT, 'personal', 'follow')]
        .filter((entry) => leafIds.some((leafId) => entry.paneKey.endsWith(leafId)))
        .map((entry) => [entry.paneKey, entry])
    )
  })
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('the tab hover card account lines', () => {
  it('names the account and what keeping means for a single agent', () => {
    seed([LEFT])
    const { container } = render(<TabAgentAccountLines tabId={TAB} />)
    expect(container.textContent).toBe('work@example.com · Kept on this account')
  })

  it('lists one line per agent pane of a split tab, in layout order', () => {
    seed([LEFT, RIGHT])
    const markup = render(<TabAgentAccountLines tabId={TAB} />).container.textContent ?? ''
    const first = markup.indexOf('1 · work@example.com · Kept on this account')
    const second = markup.indexOf('2 · personal@example.com · Follows the selected account')
    expect(first).toBeGreaterThan(-1)
    expect(second).toBeGreaterThan(first)
  })

  it('renders nothing for a tab whose host published no account', () => {
    expect(render(<TabAgentAccountLines tabId={TAB} />).container.innerHTML).toBe('')
  })

  it('shows the lines under the program line once the card opens', () => {
    vi.useFakeTimers()
    seed([LEFT])
    render(
      <TabStripTooltipProvider>
        <TabHoverCard
          title="Agent tab"
          icon={null}
          programName="Claude Code"
          details={<TabAgentAccountLines tabId={TAB} />}
        >
          <button type="button">tab</button>
        </TabHoverCard>
      </TabStripTooltipProvider>
    )
    fireEvent.pointerMove(screen.getByRole('button', { name: 'tab' }), { pointerType: 'mouse' })
    act(() => {
      vi.advanceTimersByTime(TAB_TOOLTIP_DELAY_MS)
    })

    const card = document.querySelector('[data-tab-hover-card="true"]')
    const program = card?.querySelector('[data-tab-hover-card-program]')
    const accounts = card?.querySelector('[data-tab-hover-card-accounts]')
    expect(accounts?.textContent).toContain('work@example.com · Kept on this account')
    expect(
      program && accounts
        ? program.compareDocumentPosition(accounts) & Node.DOCUMENT_POSITION_FOLLOWING
        : 0
    ).toBeTruthy()
  })
})
