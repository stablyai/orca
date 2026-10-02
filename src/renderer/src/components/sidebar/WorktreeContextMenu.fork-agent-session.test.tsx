/**
 * @vitest-environment happy-dom
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import WorktreeContextMenu from './WorktreeContextMenu'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const state = {
  updateWorktreeMeta: vi.fn(),
  setWorktreesPinnedAndReveal: vi.fn(),
  workspaceStatuses: [],
  repos: [{ id: 'repo', kind: 'git' }],
  openModal: vi.fn(),
  projectGroups: [],
  createProjectGroup: vi.fn(),
  moveProjectToGroup: vi.fn(),
  deleteStateByWorktreeId: {},
  worktreeLineageById: {},
  workspaceLineageByChildKey: {},
  updateWorktreeLineage: vi.fn(),
  tabsByWorktree: {},
  ptyIdsByTabId: {},
  browserTabsByWorktree: {},
  keybindings: {},
  settings: { activeRuntimeEnvironmentId: null, openInApplications: [] },
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))

vi.mock('@/store/selectors', () => ({
  useAllWorktrees: () => [],
  useRepoById: (repoId?: string) =>
    repoId ? { id: repoId, name: repoId, displayName: repoId, projectGroupId: null } : undefined,
  useRepoMap: () => new Map(),
  useWorktreeMap: () => new Map()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback,
  i18n: { language: 'en', on: () => {}, off: () => {} }
}))

vi.mock('./ProjectGroupNameDialog', () => ({ ProjectGroupNameDialog: () => null }))
vi.mock('./WorktreeParentPickerPopover', () => ({ WorktreeParentPickerPopover: () => null }))

const writeClipboardText = vi.fn()
const mounted: { container: HTMLDivElement; root: Root }[] = []

beforeEach(() => {
  state.repos = [{ id: 'repo', kind: 'git' }]
  state.openModal.mockReset()
  writeClipboardText.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { writeClipboardText } }
  })
})

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount())
    container.remove()
  }
  mounted.length = 0
})

function worktreeFixture(overrides: Partial<Worktree> = {}): Worktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the menu reads only the fields set here.
  return {
    id: 'repo::wt-1',
    repoId: 'repo',
    displayName: 'Fix authentication race',
    branch: 'refs/heads/feature/auth-race',
    path: '/path/to/wt-1',
    isMainWorktree: false,
    ...overrides
  } as Worktree
}

function openMenu(worktree: Worktree): void {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ container, root })
  act(() => {
    root.render(
      <TooltipProvider>
        <WorktreeContextMenu worktree={worktree}>
          <div>Card</div>
        </WorktreeContextMenu>
      </TooltipProvider>
    )
  })
  const scope = container.querySelector('[data-worktree-context-menu-scope]')
  act(() => {
    scope?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
    )
  })
}

function findMenuItem(label: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (element) => element.textContent === label
  )
}

function clickMenuItem(label: string): void {
  const item = findMenuItem(label)
  expect(item, `menu item "${label}"`).toBeTruthy()
  // Why: the menu swallows clicks until a primary pointerdown proves they aren't the opening right-click.
  act(() => {
    item?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    item?.click()
  })
}

async function hoverTooltipText(item: HTMLElement | undefined): Promise<string | null> {
  const trigger = item?.closest<HTMLElement>('[data-slot="tooltip-trigger"]')
  if (!trigger) {
    return null
  }
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
  })
  const content = document.querySelector('[data-slot="tooltip-content"]')
  // Why: Radix repeats the text in a visually hidden role="tooltip" node; read the visible copy.
  return content?.firstChild?.textContent ?? null
}

describe('WorktreeContextMenu Fork Agent Session', () => {
  it('opens the fork dialog for a git worktree', () => {
    openMenu(worktreeFixture({ branch: 'refs/heads/feedback' }))

    clickMenuItem('Fork Agent Session...')

    expect(state.openModal).toHaveBeenCalledWith('agent-session-fork', {
      sourceWorktreeId: 'repo::wt-1',
      launchSource: 'sidebar',
      preselectedPaneKey: null,
      transcript: null
    })
  })

  it('is disabled for a detached or archived worktree', () => {
    openMenu(worktreeFixture({ branch: '' }))

    const item = findMenuItem('Fork Agent Session...')

    expect(item?.getAttribute('aria-disabled')).toBe('true')
  })

  it.each([
    [{ branch: '' }, 'Check out a branch first; this workspace is on a detached commit.'],
    [{ isArchived: true }, 'Unarchive this workspace to fork it.'],
    [{ isBare: true }, 'Bare repositories have no working tree to fork.']
  ])('explains why it is disabled for %o in a tooltip', async (overrides, reason) => {
    openMenu(worktreeFixture(overrides))

    const item = findMenuItem('Fork Agent Session...')
    expect(item?.hasAttribute('title')).toBe(false)
    expect(await hoverTooltipText(item)).toBe(reason)
  })

  it('is disabled with a reason when the project record is missing', async () => {
    state.repos = []
    openMenu(worktreeFixture())

    const item = findMenuItem('Fork Agent Session...')
    expect(item?.getAttribute('aria-disabled')).toBe('true')
    expect(await hoverTooltipText(item)).toBe("This workspace's project is not available.")
  })

  it('gives no disabled reason when the worktree can be forked', async () => {
    openMenu(worktreeFixture())

    const item = findMenuItem('Fork Agent Session...')
    expect(item?.getAttribute('aria-disabled')).toBeNull()
    expect(await hoverTooltipText(item)).toBeNull()
  })

  it('is hidden for folder workspaces', () => {
    openMenu(worktreeFixture({ id: 'folder::f-1', branch: '' }))

    expect(findMenuItem('Fork Agent Session...')).toBeUndefined()
  })
})
