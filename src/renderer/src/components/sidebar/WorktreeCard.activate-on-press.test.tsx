// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeCardProperty } from '../../../../shared/ui-chrome-types'
import type { Worktree } from '../../../../shared/worktree/types'

const fetchHostedReviewForBranch = vi.fn()
const fetchIssue = vi.fn()
const fetchLinearIssue = vi.fn()
const openModal = vi.fn()
const updateWorktreeMeta = vi.fn()

let worktreeCardProperties: WorktreeCardProperty[] = ['status']
let isSleepingWorktree = false
let root: Root | null = null
let container: HTMLDivElement | null = null

vi.mock('@/store', () => {
  const getState = () => ({
    activeView: 'terminal',
    deleteStateByWorktreeId: {},
    fetchHostedReviewForBranch,
    fetchIssue,
    fetchLinearIssue,
    gitConflictOperationByWorktree: {},
    hostedReviewCache: {},
    issueCache: {},
    linearIssueCache: {},
    openModal,
    projectGroups: [],
    remoteBranchConflictByWorktreeId: {},
    repos: [{ id: 'repo-1', path: '/repo' }],
    settings: { experimentalNewWorktreeCardStyle: true },
    sshConnectionStates: new Map(),
    sleepingAgentSessionsByPaneKey: {},
    tabsByWorktree: { 'repo-1::/repo/worktrees/branch': [{ id: 'tab-1' }] },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    sshTargetLabels: new Map(),
    updateWorktreeMeta,
    workspacePortScan: null,
    worktreeCardProperties
  })
  return {
    useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(getState()), {
      getState,
      subscribe: () => () => {}
    })
  }
})

const activateWorktreeFromSidebar = vi.fn()
vi.mock('@/lib/sidebar-worktree-activation', () => ({
  activateWorktreeFromSidebar: (...args: unknown[]) => activateWorktreeFromSidebar(...args)
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownStartedAt: () => null
}))

vi.mock('./WorktreeCardAgents', () => ({
  default: () => null
}))

vi.mock('./WorktreeContextMenu', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
  WORKTREE_NATIVE_CONTEXT_MENU_ATTR: 'data-worktree-native-context-menu',
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR: 'data-orca-context-menu-scope'
}))

vi.mock('./use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'active'
}))

vi.mock('./use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => false,
  selectIsSleepingWorktree: () => isSleepingWorktree
}))

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'orca',
    badgeColor: '#999999',
    addedAt: 1
  }
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo/worktrees/branch',
    repoId: 'repo-1',
    path: '/repo/worktrees/branch',
    displayName: 'feature/branch',
    branch: 'feature/branch',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  }
}

describe('WorktreeCard press activation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    worktreeCardProperties = ['status']
    isSleepingWorktree = false
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
  })

  async function renderCard(props: { activateOnPress?: boolean } = {}): Promise<HTMLElement> {
    const { default: WorktreeCard } = await import('./WorktreeCard')
    act(() => {
      root?.render(
        <WorktreeCard
          worktree={makeWorktree()}
          repo={makeRepo()}
          isActive={false}
          activateOnPress={props.activateOnPress}
        />
      )
    })
    const surface = container?.querySelector<HTMLElement>('[data-worktree-card-surface]')
    if (!surface) {
      throw new Error('card surface not rendered')
    }
    return surface
  }

  function press(target: HTMLElement, init: PointerEventInit = {}): void {
    act(() => {
      target.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse', ...init })
      )
    })
  }

  function click(target: HTMLElement, detail: number): void {
    act(() => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }))
    })
  }

  it('activates on a plain mouse press and skips the click that ends it', async () => {
    const surface = await renderCard({ activateOnPress: true })
    const terminal = document.body.appendChild(document.createElement('textarea'))
    terminal.className = 'xterm-helper-textarea'
    activateWorktreeFromSidebar.mockImplementationOnce(() => terminal.focus())
    press(surface)
    expect(activateWorktreeFromSidebar).toHaveBeenCalledTimes(1)
    // The press's native mousedown must not pull focus from the new terminal to the list.
    const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
    act(() => {
      surface.dispatchEvent(mousedown)
    })
    expect(mousedown.defaultPrevented).toBe(true)
    click(surface, 1)
    expect(activateWorktreeFromSidebar).toHaveBeenCalledTimes(1)
    terminal.remove()
  })

  it('keeps click activation for modified, touch, and keyboard-forwarded presses', async () => {
    const surface = await renderCard({ activateOnPress: true })
    press(surface, { metaKey: true })
    press(surface, { pointerType: 'touch' })
    expect(activateWorktreeFromSidebar).not.toHaveBeenCalled()
    press(surface)
    click(surface, 0)
    expect(activateWorktreeFromSidebar).toHaveBeenCalledTimes(2)
  })

  it('waits for the click while a text field has focus', async () => {
    const surface = await renderCard({ activateOnPress: true })
    const input = document.body.appendChild(document.createElement('input'))
    input.focus()
    press(surface)
    expect(activateWorktreeFromSidebar).not.toHaveBeenCalled()
    input.remove()
  })

  it('waits for the click before waking a sleeping workspace', async () => {
    isSleepingWorktree = true
    const surface = await renderCard({ activateOnPress: true })
    press(surface)
    expect(activateWorktreeFromSidebar).not.toHaveBeenCalled()
    click(surface, 1)
    expect(activateWorktreeFromSidebar).toHaveBeenCalledTimes(1)
  })

  it('does not let a press whose click was swallowed skip a later click', async () => {
    const surface = await renderCard({ activateOnPress: true })
    press(surface)
    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'mouse' }))
    })
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    click(surface, 1)
    expect(activateWorktreeFromSidebar).toHaveBeenCalledTimes(2)
  })

  it('leaves cards outside the sidebar lists on click activation', async () => {
    const surface = await renderCard()
    press(surface)
    expect(activateWorktreeFromSidebar).not.toHaveBeenCalled()
    click(surface, 1)
    expect(activateWorktreeFromSidebar).toHaveBeenCalledTimes(1)
  })
})
