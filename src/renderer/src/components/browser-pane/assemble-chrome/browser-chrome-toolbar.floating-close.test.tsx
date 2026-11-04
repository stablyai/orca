// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { FLOATING_TERMINAL_WORKTREE_ID as FLOATING } from '../../../../../shared/constants'
import { BrowserChromeToolbar } from './browser-chrome-toolbar'

const PAGE_ID = 'page-1'
const WORKSPACE_ID = 'browser-1'
const TAB_ID = 'tab-browser'

function seed(worktreeId: string, options: { split: boolean; isPinned?: boolean }): void {
  const group = (id: string, tabOrder: string[]) => ({
    id,
    worktreeId,
    activeTabId: tabOrder[0] ?? null,
    tabOrder,
    recentTabIds: tabOrder
  })
  const page = {
    id: PAGE_ID,
    workspaceId: WORKSPACE_ID,
    worktreeId,
    url: 'https://example.com',
    title: 'Example',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0
  }
  const base = { worktreeId, customLabel: null, color: null, sortOrder: 0, createdAt: 0 }
  useAppStore.setState({
    groupsByWorktree: {
      [worktreeId]: options.split
        ? [group('left', ['tab-terminal']), group('right', [TAB_ID])]
        : [group('right', [TAB_ID])]
    },
    activeGroupIdByWorktree: { [worktreeId]: options.split ? 'left' : 'right' },
    layoutByWorktree: {
      [worktreeId]: options.split
        ? {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: 'left' },
            second: { type: 'leaf', groupId: 'right' }
          }
        : { type: 'leaf', groupId: 'right' }
    },
    unifiedTabsByWorktree: {
      [worktreeId]: [
        ...(options.split
          ? [
              {
                ...base,
                id: 'tab-terminal',
                entityId: 'terminal-1',
                groupId: 'left',
                contentType: 'terminal' as const,
                label: 'Terminal'
              }
            ]
          : []),
        {
          ...base,
          id: TAB_ID,
          entityId: WORKSPACE_ID,
          groupId: 'right',
          contentType: 'browser' as const,
          label: 'Example',
          isPinned: options.isPinned
        }
      ]
    },
    browserTabsByWorktree: {
      [worktreeId]: [{ ...page, id: WORKSPACE_ID, activePageId: PAGE_ID, pageIds: [PAGE_ID] }]
    },
    browserPagesByWorkspace: { [WORKSPACE_ID]: [page] }
  })
}

function renderToolbar(worktreeId: string): void {
  render(
    <TooltipProvider>
      <BrowserChromeToolbar
        closeTabOwner={{ worktreeId, browserPageId: PAGE_ID }}
        controls={{
          canGoBack: false,
          canGoForward: false,
          goBack: () => {},
          goForward: () => {},
          reload: () => {},
          navigate: () => {}
        }}
        addressSlot={null}
        elementTools={null}
        markup={{ active: false, disabled: false, onToggle: () => {}, canShowDiscoveryHint: false }}
        viewSource={null}
        openExternal={null}
        overflowMenu={() => null}
      />
    </TooltipProvider>
  )
}

const closeButton = () => screen.queryByRole('button', { name: 'Close tab' })

beforeAll(() => {
  const api: unknown = new Proxy(() => {}, {
    get: (_target, key) => (key === 'then' ? undefined : api),
    apply: () => Promise.resolve(undefined)
  })
  Object.defineProperty(window, 'api', { value: api, configurable: true })
})
afterEach(cleanup)

describe('BrowserChromeToolbar close button', () => {
  it('closes only the browser in a floating split and collapses the split', () => {
    seed(FLOATING, { split: true })
    renderToolbar(FLOATING)

    fireEvent.click(closeButton()!)

    const state = useAppStore.getState()
    expect(state.unifiedTabsByWorktree[FLOATING].map((tab) => tab.id)).toEqual(['tab-terminal'])
    expect(state.layoutByWorktree[FLOATING]).toEqual({ type: 'leaf', groupId: 'left' })
  })

  it.each([
    ['an unsplit floating panel', FLOATING, { split: false }],
    ['the main window', 'wt-main', { split: true }],
    ['a pinned tab', FLOATING, { split: true, isPinned: true }]
  ])('stays hidden for %s', (_case, worktreeId, options) => {
    seed(worktreeId, options)
    renderToolbar(worktreeId)
    expect(closeButton()).toBeNull()
  })
})
