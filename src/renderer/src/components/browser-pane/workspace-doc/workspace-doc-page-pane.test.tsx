/**
 * @vitest-environment happy-dom
 *
 * STA-5557: a preview hands its guest the keyboard, so what counts as "the reader is in this
 * preview" is load-bearing in both directions — too narrow and the one route out of a preview stays
 * shut, too wide and it takes the keyboard from the terminal the reader is actually typing in.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage } from '../../../../../shared/browser-workspace-types'

const WORKTREE_ID = 'repo1::/path/wt1'
const WORKSPACE_ID = 'workspace-1'
const OTHER_WORKSPACE_ID = 'workspace-2'

const mocks = vi.hoisted(() => ({
  storeState: {} as Record<string, unknown>,
  handedFocus: [] as (boolean | undefined)[]
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(mocks.storeState)
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => null
}))
vi.mock('./HtmlDocPreview', () => ({
  HtmlDocPreview: ({ holdsGuestFocus }: { holdsGuestFocus?: boolean }) => {
    mocks.handedFocus.push(holdsGuestFocus)
    return null
  }
}))

import { WorkspaceDocPagePane } from './workspace-doc-page-pane'

function docPage(): BrowserPage {
  return {
    id: 'page-1',
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    url: 'about:blank',
    title: 'index.html',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0,
    docLocation: {
      kind: 'workspace-doc',
      worktreeId: WORKTREE_ID,
      filePath: '/path/wt1/report/index.html'
    }
  }
}

describe('the surface a document pane will hand its guest the keyboard from', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    mocks.handedFocus = []
    mocks.storeState = {
      activeTabTypeByWorktree: { [WORKTREE_ID]: 'browser' },
      activeBrowserTabIdByWorktree: { [WORKTREE_ID]: WORKSPACE_ID },
      getKnownWorktreeById: () => ({ path: '/path/wt1' })
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function renderPane(isActive: boolean): boolean | undefined {
    act(() => {
      root.render(<WorkspaceDocPagePane page={docPage()} isActive={isActive} />)
    })
    return mocks.handedFocus.at(-1)
  }

  // The presence half: with the reader in this very preview the answer has to be yes, so a pane
  // that had stopped offering focus at all would fail here rather than pass every refusal below.
  it('hands focus on when the reader is in this preview', () => {
    expect(renderPane(true)).toBe(true)
  })

  it('refuses while the reader is in a terminal in front of it', () => {
    mocks.storeState.activeTabTypeByWorktree = { [WORKTREE_ID]: 'terminal' }

    expect(renderPane(true)).toBe(false)
  })

  // Why this is separate from the terminal case: the reader can be in the browser and still be
  // looking at another tab of it, which is a different half of the check.
  it('refuses while the reader is in a different browser tab', () => {
    mocks.storeState.activeBrowserTabIdByWorktree = { [WORKTREE_ID]: OTHER_WORKSPACE_ID }

    expect(renderPane(true)).toBe(false)
  })

  it('refuses while its own page is not the active one', () => {
    expect(renderPane(false)).toBe(false)
  })
})
