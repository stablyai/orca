// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo, Worktree } from '../../../shared/types'
import { useAppStore } from '@/store'
import WorktreeJumpPalette from './WorktreeJumpPalette'

// Why: called unconditionally at the top of WorktreeJumpPaletteContent, so its
// call count is a direct render counter for the content component.
const contentRenderProbe = vi.hoisted(() => vi.fn(() => []))

vi.mock('@/hooks/useSettingsNavigationMetadata', () => ({
  useSettingsNavigationMetadata: contentRenderProbe
}))

// Why: the gating tests target the shell/content mount seam, not cmdk/Radix
// behavior — lightweight stand-ins keep the DOM assertions deterministic.
vi.mock('@/components/ui/command', () => ({
  CommandDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="worktree-jump-palette">{children}</div> : null,
  CommandInput: ({ value }: { value: string }) => (
    <input data-testid="palette-input" value={value} readOnly />
  ),
  CommandList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-command-item={value}>{children}</div>
  )
}))

const initialAppState = useAppStore.getInitialState()

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
    id: 'wt-alpha',
    repoId: 'repo-1',
    path: '/repo/worktrees/alpha',
    displayName: 'palette-alpha',
    branch: 'feature/palette-alpha',
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

// Why: replacing a map's identity without changing its contents is exactly the
// store churn (#7558's re-render trigger) the closed palette must not react to.
const CLOSED_CHURN_WRITES: readonly [string, () => void][] = [
  ['prCache', () => useAppStore.setState((s) => ({ prCache: { ...s.prCache } }))],
  ['issueCache', () => useAppStore.setState((s) => ({ issueCache: { ...s.issueCache } }))],
  [
    'retainedAgentsByPaneKey',
    () =>
      useAppStore.setState((s) => ({ retainedAgentsByPaneKey: { ...s.retainedAgentsByPaneKey } }))
  ],
  [
    'unifiedTabsByWorktree',
    () => useAppStore.setState((s) => ({ unifiedTabsByWorktree: { ...s.unifiedTabsByWorktree } }))
  ],
  [
    'agentStatusByPaneKey',
    () => useAppStore.setState((s) => ({ agentStatusByPaneKey: { ...s.agentStatusByPaneKey } }))
  ],
  [
    'runtimePaneTitlesByTabId',
    () =>
      useAppStore.setState((s) => ({ runtimePaneTitlesByTabId: { ...s.runtimePaneTitlesByTabId } }))
  ]
]

function churnAllClosedWriteTargets(): void {
  for (const [, write] of CLOSED_CHURN_WRITES) {
    act(() => write())
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function renderPalette(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<WorktreeJumpPalette />)
  })
}

function paletteDialog(): Element | null {
  return document.querySelector('[data-testid="worktree-jump-palette"]')
}

beforeEach(() => {
  useAppStore.setState(initialAppState, true)
  useAppStore.setState({
    repos: [makeRepo()],
    worktreesByRepo: {
      'repo-1': [
        makeWorktree(),
        makeWorktree({
          id: 'wt-bravo',
          path: '/repo/worktrees/bravo',
          displayName: 'palette-bravo',
          branch: 'feature/palette-bravo',
          sortOrder: 1
        })
      ]
    },
    showSleepingWorkspaces: true,
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false
  })
  contentRenderProbe.mockClear()
})

afterEach(async () => {
  vi.useRealTimers()
  if (root) {
    await act(async () => {
      root?.unmount()
    })
  }
  container?.remove()
  container = null
  root = null
  useAppStore.setState(initialAppState, true)
})

describe('WorktreeJumpPalette closed-render gating', () => {
  it('mounts no content and renders zero times on store churn while closed', async () => {
    await renderPalette()

    expect(paletteDialog()).toBeNull()
    expect(contentRenderProbe).not.toHaveBeenCalled()

    churnAllClosedWriteTargets()

    expect(contentRenderProbe).not.toHaveBeenCalled()
    expect(paletteDialog()).toBeNull()
  })

  it('shows data mutated while closed as soon as it opens', async () => {
    await renderPalette()

    // A worktree created while the palette is closed must not render anything...
    act(() => {
      useAppStore.setState((s) => ({
        worktreesByRepo: {
          ...s.worktreesByRepo,
          'repo-1': [
            ...(s.worktreesByRepo['repo-1'] ?? []),
            makeWorktree({
              id: 'wt-charlie',
              path: '/repo/worktrees/charlie',
              displayName: 'palette-charlie',
              branch: 'feature/palette-charlie',
              sortOrder: 2
            })
          ]
        }
      }))
    })
    expect(contentRenderProbe).not.toHaveBeenCalled()

    // ...but must be visible on the very first open, with no stale snapshot.
    act(() => {
      useAppStore.getState().openModal('worktree-palette')
    })

    expect(contentRenderProbe).toHaveBeenCalled()
    const dialog = paletteDialog()
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('palette-alpha')
    expect(dialog?.textContent).toContain('palette-charlie')
  })

  it('opens from the fully unmounted state via the store action the Cmd+J IPC handler drives', async () => {
    await renderPalette()
    expect(contentRenderProbe).not.toHaveBeenCalled()

    // Why: the Cmd+J accelerator lives above this component (menu → IPC →
    // useIpcEvents → openModal), so the shortcut path reduces to this action.
    act(() => {
      useAppStore.getState().openModal('worktree-palette')
    })
    expect(paletteDialog()).not.toBeNull()
    expect(document.querySelector('[data-testid="palette-input"]')).not.toBeNull()

    act(() => {
      useAppStore.getState().closeModal()
    })
    expect(paletteDialog()).toBeNull()
  })

  it('unmounts content after the close linger and stops reacting to churn again', async () => {
    vi.useFakeTimers()
    await renderPalette()

    act(() => {
      useAppStore.getState().openModal('worktree-palette')
    })
    expect(contentRenderProbe).toHaveBeenCalled()

    // Positive control: while open, the hot status maps are live-subscribed,
    // so identity churn must re-render the content.
    contentRenderProbe.mockClear()
    act(() => {
      useAppStore.setState((s) => ({ agentStatusByPaneKey: { ...s.agentStatusByPaneKey } }))
    })
    expect(contentRenderProbe).toHaveBeenCalled()

    act(() => {
      useAppStore.getState().closeModal()
    })
    // During the linger window the content must stay mounted with live status
    // maps (`#7558` semantics) — dropping them here would flash the switcher
    // rows empty mid close animation.
    contentRenderProbe.mockClear()
    act(() => {
      useAppStore.setState((s) => ({ agentStatusByPaneKey: { ...s.agentStatusByPaneKey } }))
    })
    expect(contentRenderProbe).toHaveBeenCalled()

    // Past the linger window the content unmounts.
    act(() => {
      vi.advanceTimersByTime(400)
    })

    contentRenderProbe.mockClear()
    churnAllClosedWriteTargets()
    expect(contentRenderProbe).not.toHaveBeenCalled()
  })
})
