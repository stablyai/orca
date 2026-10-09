// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactI18Next from 'react-i18next'
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
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  LEAF_ID,
  makeAgentEntry,
  makeRecentTabState,
  makeRepo
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

vi.mock('@/components/ui/command', async () => {
  const React = await import('react')
  return {
    Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    // The controlled value is what Enter would activate.
    CommandDialog: ({
      children,
      open,
      commandProps
    }: {
      children: React.ReactNode
      open?: boolean
      commandProps?: { value?: string }
    }) =>
      open ? (
        <div data-command-dialog="true" data-command-value={commandProps?.value ?? ''}>
          {children}
        </div>
      ) : null,
    CommandInput: ({
      value,
      onValueChange
    }: {
      value?: string
      onValueChange?: (next: string) => void
    }) => {
      setCommandQuery = onValueChange ?? null
      return <input data-command-input="true" value={value} readOnly />
    },
    CommandList: React.forwardRef(function CommandList(
      { children }: { children: React.ReactNode },
      ref: React.ForwardedRef<HTMLDivElement>
    ) {
      return <div ref={ref}>{children}</div>
    }),
    CommandEmpty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandItem: ({ children, value }: { children: React.ReactNode; value?: string }) => (
      <div data-command-item={value ?? ''}>{children}</div>
    )
  }
})

const searchSessions =
  vi.fn<
    (request: AiVaultSearchRequest, scope?: ExecutionHostScope) => Promise<AiVaultSearchResponse>
  >()
const initialAppState = useAppStore.getInitialState()
let testRoot: Root
let testContainer: HTMLDivElement
let setCommandQuery: ((next: string) => void) | null = null

function hit(sessionId: string, snippet: string): AiVaultSearchHit {
  return {
    ...searchHit(),
    agent: 'claude',
    sessionId,
    evidence: { role: 'assistant', timestamp: null, snippet }
  }
}

function answer(hits: AiVaultSearchHit[]): void {
  searchSessions.mockResolvedValue({ ...searchResults(), hits })
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
  await act(async () => setCommandQuery?.(query))
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
  return [...testContainer.querySelectorAll<HTMLElement>('[data-command-item]')].map(
    (node) => node.dataset.commandItem ?? ''
  )
}

describe('WorktreeJumpPalette transcript matches', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    setCommandQuery = null
    searchSessions.mockReset()
    answer([])
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ...window.api, aiVault: { searchSessions } }
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
  })

  it('lists an open chat whose transcript, not its title, matches', async () => {
    answer([hit('s-alpha', 'the [[zebra]] crossing')])
    await renderPalette(true)
    await type('zebra')
    expect(tabRowIds()).toEqual([])

    await settleSearch()

    expect(searchSessions).toHaveBeenCalledExactlyOnceWith(
      { query: 'zebra', limit: 100, cursor: undefined },
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
    const dialog = () => testContainer.querySelector<HTMLElement>('[data-command-dialog="true"]')
    const selectedBefore = dialog()?.dataset.commandValue
    expect(selectedBefore).toBeTruthy()

    await settleSearch()

    expect(tabRowIds()).toEqual(['tab-beta', 'tab-alpha'])
    expect(dialog()?.dataset.commandValue).toBe(selectedBefore)
  })
})
