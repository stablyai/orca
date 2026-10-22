// @vitest-environment happy-dom

import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import * as tabActivation from '@/lib/workspace-tab-palette-activation'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactI18Next from 'react-i18next'
import type * as CommandPrimitives from '@/components/ui/command'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import WorktreeJumpPalette from './WorktreeJumpPalette'
import { encodePaletteIdentity } from '@/lib/palette-match/palette-ranking'
import { getDefaultSettings } from '../../../shared/constants'
import type {
  AiVaultSearchHit,
  AiVaultSearchRequest,
  AiVaultSearchResponse
} from '../../../shared/ai-vault-search-types'
import type { ExecutionHostScope } from '../../../shared/execution-host'
import { searchHit, searchResults } from '../../../shared/ai-vault-search-test-fixture'
import { structuredAgentSessionPaneKey } from '../../../shared/structured-agent-session-projection'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  LEAF_ID,
  makeAgentEntry,
  makeRecentTabState,
  makeRepo,
  makeUnifiedTab
} from './worktree-jump-palette-test-fixtures'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18Next>()
  return {
    ...actual,
    useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key })
  }
})
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), message: vi.fn() }
}))
vi.mock('@/hooks/useSettingsNavigationMetadata', () => ({
  useSettingsNavigationMetadata: () => []
}))
vi.mock('@/components/sidebar/StatusIndicator', () => ({
  default: () => <span data-status-indicator="true" />
}))
vi.mock('@/components/repo/RepoBadgeLabel', () => ({
  RepoBadgeMark: () => <span data-repo-badge-mark="true" />
}))
vi.mock('@/components/cmd-j/palette-host-badge', () => ({ getPaletteHostBadge: () => null }))

vi.mock('@/components/ui/command', async (importOriginal) => {
  const actual = await importOriginal<typeof CommandPrimitives>()
  return {
    ...actual,
    CommandDialog: ({
      children,
      open,
      commandProps
    }: {
      children: React.ReactNode
      open?: boolean
      commandProps?: React.ComponentProps<typeof actual.Command>
    }) =>
      open ? (
        <actual.Command shouldFilter={false} {...commandProps}>
          {children}
        </actual.Command>
      ) : null
  }
})

const searchSessions =
  vi.fn<
    (request: AiVaultSearchRequest, scope?: ExecutionHostScope) => Promise<AiVaultSearchResponse>
  >()
const initialAppState = useAppStore.getInitialState()
let testRoot: Root
let testContainer: HTMLDivElement

function hit(sessionId: string, snippet: string): AiVaultSearchHit {
  return {
    ...searchHit(),
    agent: 'claude',
    sessionId,
    evidence: { role: 'assistant', timestamp: null, snippet }
  }
}

function answer(hits: AiVaultSearchHit[]): void {
  searchSessions.mockResolvedValue({
    ...searchResults(),
    hits,
    eligibleSessionsApplied: true,
    forksPreserved: true
  })
}

function paneState(): Partial<AppState> {
  const pane = (tabId: string, worktreeId: string, sessionId: string) =>
    makeAgentEntry(tabId, 'done', 0, {
      agentType: 'claude',
      tabId,
      worktreeId,
      providerSession: { key: 'session_id', id: sessionId }
    })
  const layout = {
    root: { type: 'leaf' as const, leafId: LEAF_ID },
    activeLeafId: LEAF_ID,
    expandedLeafId: null
  }
  return {
    agentStatusByPaneKey: {
      [makePaneKey('term-alpha', LEAF_ID)]: pane('term-alpha', 'wt-alpha', 's-alpha'),
      [makePaneKey('term-beta', LEAF_ID)]: pane('term-beta', 'wt-beta', 's-beta')
    },
    terminalLayoutsByTabId: { 'term-alpha': layout, 'term-beta': layout }
  }
}

async function renderPalette(
  indexEnabled: boolean,
  activeRuntimeEnvironmentId: string | null = null
): Promise<void> {
  useAppStore.setState({
    activeModal: 'worktree-palette',
    activeWorktreeId: null,
    repos: [makeRepo()],
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    lastVisitedAtByWorktreeId: {},
    settings: {
      ...getDefaultSettings('/home/test'),
      aiVaultSearch: { enabled: indexEnabled, historyDays: null },
      activeRuntimeEnvironmentId
    },
    ...makeRecentTabState(paneState())
  })
  await act(async () => testRoot.render(<WorktreeJumpPalette />))
}

async function type(query: string): Promise<void> {
  await act(async () =>
    fireEvent.change(testContainer.querySelector('[cmdk-input]')!, { target: { value: query } })
  )
}

async function settleSearch(): Promise<void> {
  await act(async () => vi.advanceTimersByTimeAsync(500))
}

// Suffix match: a repeated row renders under a `palette-dup:` prefix and must still count.
function tabRowIds(): string[] {
  return allRowIds()
    .map((id) =>
      ['tab-alpha', 'tab-beta'].find((tabId) =>
        id.endsWith(encodePaletteIdentity(['workspace-tab', '', tabId.replace('tab', 'wt'), tabId]))
      )
    )
    .filter((tabId) => tabId !== undefined)
}

function snippets(): string[] {
  return [
    ...testContainer.querySelectorAll('[data-slot="palette-open-tab-transcript-snippet"]')
  ].map((node) => node.textContent ?? '')
}

function allRowIds(): string[] {
  return [...testContainer.querySelectorAll<HTMLElement>('[cmdk-item]')].map(
    (node) => node.dataset.value ?? ''
  )
}

describe('WorktreeJumpPalette transcript matches', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    searchSessions.mockReset()
    answer([])
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        aiVault: { searchSessions },
        gh: { listWorkItems: vi.fn().mockResolvedValue({ items: [], hasMore: false }) }
      }
    })
    useAppStore.setState(initialAppState, true)
    testContainer = document.createElement('div')
    document.body.appendChild(testContainer)
    testRoot = createRoot(testContainer)
  })

  afterEach(async () => {
    await act(async () => testRoot.unmount())
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('finds a native chat by a version component in its transcript', async () => {
    const text = 'Browser annotation "Send" no longer auto-submits to agent (v1.4.217)'
    answer([
      {
        ...hit('native-provider', ''),
        evidence: {
          role: 'user',
          timestamp: null,
          snippet: text,
          originalExcerpt: { text, startsMessage: true, endsMessage: true }
        }
      }
    ])
    await renderPalette(true)
    const tab = {
      ...makeUnifiedTab('native-tab', 'wt-alpha', 'native-session', 'Browser annotation'),
      contentType: 'agent-session' as const,
      agentSessionAgent: 'claude' as const
    }
    const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
    await act(async () =>
      useAppStore.setState({
        unifiedTabsByWorktree: { 'wt-alpha': [tab] },
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        agentStatusByPaneKey: {
          [paneKey]: makeAgentEntry(tab.id, 'done', 0, {
            paneKey,
            tabId: tab.id,
            worktreeId: tab.worktreeId,
            agentType: 'claude',
            providerSession: { key: 'session_id', id: 'native-provider' }
          })
        }
      })
    )
    await type('217')
    await settleSearch()
    expect(searchSessions.mock.lastCall?.[0].eligibleSessions?.providers).toEqual([
      { agent: 'claude', sessionId: 'native-provider' }
    ])
    const rows = [...testContainer.querySelectorAll('[cmdk-item]')]
    const chat = rows.find((row) => row.textContent?.includes('Browser annotation'))
    expect(chat).toBeDefined()
    expect(
      chat?.querySelector('[data-slot="palette-open-tab-transcript-snippet"]')?.textContent
    ).toContain('217')
    expect(chat?.querySelector('[data-agent-icon="claude"]')).not.toBeNull()
  })

  it('lists an open chat whose transcript, not its title, matches', async () => {
    answer([hit('s-alpha', 'the [[zebra]] crossing')])
    await renderPalette(true)
    await type('zebra')
    expect(tabRowIds()).toEqual([])

    await settleSearch()

    expect(searchSessions).toHaveBeenCalledExactlyOnceWith(
      {
        query: 'zebra',
        limit: 100,
        cursor: undefined,
        preserveForks: true,
        includeOriginalExcerpt: true,
        eligibleSessions: {
          providers: [
            { agent: 'claude', sessionId: 's-alpha' },
            { agent: 'claude', sessionId: 's-beta' }
          ],
          prompts: []
        }
      },
      'local'
    )
    expect(tabRowIds()).toEqual(['tab-alpha'])
    expect(snippets()).toEqual(['the zebra crossing'])
  })

  it('keeps local chats while a runtime environment is focused', async () => {
    answer([hit('s-alpha', 'the [[zebra]] crossing')])
    await renderPalette(true, 'runtime-env')
    await type('zebra')
    await settleSearch()

    expect(tabRowIds()).toEqual(['tab-alpha'])
  })

  it('refreshes an existing pane’s session without reopening or refreshing the presentation snapshot', async () => {
    answer([hit('s-alpha', 'the [[zebra]] crossing')])
    await renderPalette(true)
    await type('zebra')
    await settleSearch()
    expect(tabRowIds()).toEqual(['tab-alpha'])
    const initialTabs = useAppStore.getState().tabsByWorktree
    const initialUnifiedTabs = useAppStore.getState().unifiedTabsByWorktree
    const key = makePaneKey('term-alpha', LEAF_ID)
    const entry = useAppStore.getState().agentStatusByPaneKey[key]
    answer([hit('s-alpha-next', 'the new [[zebra]] crossing')])
    await act(async () =>
      useAppStore.setState({
        agentStatusByPaneKey: {
          ...useAppStore.getState().agentStatusByPaneKey,
          [key]: { ...entry, providerSession: { key: 'session_id', id: 's-alpha-next' } }
        }
      })
    )
    expect(tabRowIds()).toEqual([])
    await settleSearch()
    expect(searchSessions.mock.lastCall?.[0].eligibleSessions?.providers).toContainEqual({
      agent: 'claude',
      sessionId: 's-alpha-next'
    })
    expect(searchSessions).toHaveBeenCalledTimes(2)
    expect(tabRowIds()).toEqual(['tab-alpha'])
    expect(snippets()).toEqual(['the new zebra crossing'])
    expect(useAppStore.getState().tabsByWorktree).toBe(initialTabs)
    expect(useAppStore.getState().unifiedTabsByWorktree).toBe(initialUnifiedTabs)

    await act(async () =>
      useAppStore.setState({
        agentStatusByPaneKey: {
          ...useAppStore.getState().agentStatusByPaneKey,
          [key]: { ...useAppStore.getState().agentStatusByPaneKey[key], updatedAt: 100 }
        }
      })
    )
    await settleSearch()
    expect(searchSessions).toHaveBeenCalledTimes(2)
    expect(tabRowIds()).toEqual(['tab-alpha'])
  })

  it('keeps fork sessions in separate tabs visible while deduplicating repeated hits for one tab', async () => {
    answer([
      hit('s-alpha', 'the first [[zebra]] crossing'),
      hit('s-beta', 'the second [[zebra]] crossing'),
      hit('s-alpha-fork', 'the forked [[zebra]] crossing')
    ])
    await renderPalette(true)
    const splitLeafId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const paneKey = makePaneKey('term-alpha', splitLeafId)
    await act(async () =>
      useAppStore.setState({
        agentStatusByPaneKey: {
          ...useAppStore.getState().agentStatusByPaneKey,
          [paneKey]: makeAgentEntry('term-alpha', 'done', 0, {
            paneKey,
            agentType: 'claude',
            tabId: 'term-alpha',
            worktreeId: 'wt-alpha',
            providerSession: { key: 'session_id', id: 's-alpha-fork' }
          })
        },
        terminalLayoutsByTabId: {
          ...useAppStore.getState().terminalLayoutsByTabId,
          'term-alpha': {
            root: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: LEAF_ID },
              second: { type: 'leaf', leafId: splitLeafId }
            },
            activeLeafId: LEAF_ID,
            expandedLeafId: null
          }
        }
      })
    )
    await type('zebra')
    await settleSearch()
    expect(tabRowIds()).toEqual(['tab-alpha', 'tab-beta'])
    expect(snippets()).toEqual(['the first zebra crossing', 'the second zebra crossing'])
  })

  it('uses title matches when an older host acknowledges eligibility but still folds forks', async () => {
    searchSessions.mockResolvedValue({
      ...searchResults(),
      eligibleSessionsApplied: true,
      hits: [hit('s-alpha', 'the [[Beta]] crossing')]
    })
    await renderPalette(true)
    await type('Beta')
    await settleSearch()
    expect(tabRowIds()).toEqual(['tab-beta'])
    expect(snippets().filter(Boolean)).toEqual([])
  })

  it('uses title matches only when an older host cannot acknowledge eligibility', async () => {
    searchSessions.mockResolvedValue({
      ...searchResults(),
      hits: [hit('s-alpha', 'a [[Beta]] here')]
    })
    await renderPalette(true)
    await type('Beta')
    await settleSearch()
    expect(tabRowIds()).toEqual(['tab-beta'])
    expect(snippets().filter(Boolean)).toEqual([])
  })

  it('shows a chat matched by title and transcript once, with the snippet', async () => {
    answer([hit('s-alpha', 'about [[Alpha]] rollout')])
    await renderPalette(true)
    await type('Alpha chat')
    expect(tabRowIds()).toEqual(['tab-alpha'])

    await settleSearch()

    expect(tabRowIds()).toEqual(['tab-alpha'])
    expect(snippets()).toEqual(['about Alpha rollout'])
  })

  it('never lists an indexed session that has no pane', async () => {
    answer([hit('s-closed', 'a [[zebra]]')])
    await renderPalette(true)
    await type('zebra')
    await settleSearch()

    expect(searchSessions).toHaveBeenCalledOnce()
    expect(tabRowIds()).toEqual([])
    expect(snippets()).toEqual([])
  })

  it('matches by title only when the index is unavailable or off', async () => {
    searchSessions.mockResolvedValue({ kind: 'unavailable', reason: 'not-ready' })
    await renderPalette(true)
    await type('Beta')
    const titleOnlyRows = allRowIds()
    await settleSearch()

    expect(searchSessions).toHaveBeenCalledOnce()
    expect(allRowIds()).toEqual(titleOnlyRows)
    expect(tabRowIds()).toEqual(['tab-beta'])

    await act(async () => testRoot.unmount())
    testRoot = createRoot(testContainer)
    searchSessions.mockClear()
    await renderPalette(false)
    await type('Beta')
    await settleSearch()

    expect(searchSessions).not.toHaveBeenCalled()
    expect(allRowIds()).toEqual(titleOnlyRows)
  })

  it('keeps the selection in place when transcript matches arrive', async () => {
    answer([hit('s-alpha', 'the [[Beta]] branch')])
    await renderPalette(true)
    await type('Beta')
    const selected = () =>
      testContainer.querySelector<HTMLElement>('[cmdk-item][data-selected="true"]')?.dataset.value
    const selectedBefore = selected()
    expect(selectedBefore).toBeTruthy()

    await settleSearch()

    expect(tabRowIds()).toEqual(['tab-beta', 'tab-alpha'])
    expect(selected()).toBe(selectedBefore)
  })
  it('preserves the selected destination through async arrivals and recovers to the first survivor on removal', async () => {
    answer([hit('s-beta', 'a [[zebra]] here')])
    await renderPalette(true)
    await type('zebra')
    await settleSearch()
    const selected = () =>
      testContainer.querySelector<HTMLElement>('[cmdk-item][data-selected="true"]')?.dataset.value
    const input = () => testContainer.querySelector<HTMLInputElement>('[cmdk-input]')!
    const beta = () =>
      [...testContainer.querySelectorAll<HTMLElement>('[cmdk-item]')].find((node) =>
        node.dataset.value?.endsWith(
          encodePaletteIdentity(['workspace-tab', '', 'wt-beta', 'tab-beta'])
        )
      )!
    await act(async () => fireEvent.keyDown(input(), { key: 'Home' }))
    await act(async () => fireEvent.pointerMove(beta()))
    const betaSelection = selected()
    expect(betaSelection).toBe(beta().dataset.value)

    answer([hit('s-alpha', 'a [[zebra]] here'), hit('s-beta', 'a [[zebra]] here')])
    const newLeaf = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const key = makePaneKey('term-alpha', newLeaf)
    await act(async () =>
      useAppStore.setState({
        agentStatusByPaneKey: {
          ...useAppStore.getState().agentStatusByPaneKey,
          [key]: makeAgentEntry('term-alpha', 'done', 0, {
            paneKey: key,
            agentType: 'claude',
            tabId: 'term-alpha',
            worktreeId: 'wt-alpha',
            providerSession: { key: 'session_id', id: 's-extra' }
          })
        },
        terminalLayoutsByTabId: {
          ...useAppStore.getState().terminalLayoutsByTabId,
          'term-alpha': {
            root: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: LEAF_ID },
              second: { type: 'leaf', leafId: newLeaf }
            },
            activeLeafId: LEAF_ID,
            expandedLeafId: null
          }
        }
      })
    )
    await settleSearch()
    expect(tabRowIds()).toContain('tab-alpha')
    expect(selected()).toBe(betaSelection)

    await act(async () =>
      useAppStore.setState({
        tabsByWorktree: { ...useAppStore.getState().tabsByWorktree, 'wt-beta': [] },
        unifiedTabsByWorktree: { ...useAppStore.getState().unifiedTabsByWorktree, 'wt-beta': [] }
      })
    )
    expect(selected()).toBe(allRowIds()[0])
    expect(selected()).not.toBe(betaSelection)
    const first = selected()
    await act(async () => fireEvent.keyDown(input(), { key: 'ArrowDown' }))
    expect(selected()).not.toBe(first)
    await act(async () => fireEvent.keyDown(input(), { key: 'ArrowUp' }))
    expect(selected()).toBe(first)
    const activate = vi
      .spyOn(tabActivation, 'activateWorkspaceTabPaletteResult')
      .mockReturnValue({ status: 'activated' })
    await act(async () => fireEvent.keyDown(input(), { key: 'Enter' }))
    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'tab-alpha',
        entityId: 'term-alpha',
        worktreeId: 'wt-alpha'
      })
    )
  })
})
