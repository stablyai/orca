// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactI18Next from 'react-i18next'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import WorktreeJumpPalette from './WorktreeJumpPalette'
import { makeRepo, makeWorktree } from './worktree-jump-palette-test-fixtures'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18Next>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: string) => fallback ?? _key
    })
  }
})

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn()
  }
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

vi.mock('@/components/cmd-j/palette-host-badge', () => ({
  getPaletteHostBadge: () => null
}))

// Why: activation reaches into window.api and the whole worktree-reveal path; the palette's own
// contract is which result it hands over, so stub the boundary and assert on that.
const { activateWorkspaceTabPaletteResult } = vi.hoisted(() => ({
  activateWorkspaceTabPaletteResult: vi.fn((_result: unknown) => ({ status: 'activated' }) as const)
}))
vi.mock('@/lib/workspace-tab-palette-activation', () => ({
  activateWorkspaceTabPaletteResult: (result: unknown) => activateWorkspaceTabPaletteResult(result)
}))

vi.mock('@/components/ui/command', async () => {
  const React = await import('react')
  return {
    // Why the commandProps passthrough: cmdk resolves Enter against its `value`, so the controlled
    // value is the only honest stand-in for "what would Enter activate" without mounting real cmdk.
    CommandDialog: ({
      children,
      open,
      commandProps
    }: {
      children: React.ReactNode
      open?: boolean
      commandProps?: { value?: string; onValueChange?: (next: string) => void }
    }) => {
      return open ? (
        <div data-command-dialog="true" data-command-value={commandProps?.value ?? ''}>
          {children}
        </div>
      ) : null
    },
    Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandInput: React.forwardRef(function CommandInput(
      {
        value,
        onValueChange,
        placeholder,
        onClick,
        onSelect,
        onKeyDown
      }: {
        value?: string
        onValueChange?: (next: string) => void
        placeholder?: string
        onClick?: React.MouseEventHandler<HTMLInputElement>
        onSelect?: React.ReactEventHandler<HTMLInputElement>
        onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>
      },
      ref: React.ForwardedRef<HTMLInputElement>
    ) {
      setCommandQuery = onValueChange ?? null
      return (
        <input
          ref={ref}
          data-command-input="true"
          placeholder={placeholder}
          value={value}
          onChange={(event) => onValueChange?.(event.currentTarget.value)}
          onClick={onClick}
          onSelect={onSelect}
          onKeyDown={onKeyDown}
        />
      )
    }),
    CommandList: React.forwardRef(function CommandList(
      { children }: { children: React.ReactNode },
      ref: React.ForwardedRef<HTMLDivElement>
    ) {
      return (
        <div ref={ref} data-command-list="true">
          {children}
        </div>
      )
    }),
    CommandEmpty: ({ children }: { children: React.ReactNode }) => (
      <div data-command-empty="true">{children}</div>
    ),
    CommandItem: ({
      children,
      onSelect,
      value
    }: {
      children: React.ReactNode
      onSelect?: (value: string) => void
      value?: string
    }) => (
      <button data-command-item={value ?? ''} onClick={() => onSelect?.(value ?? '')} type="button">
        {children}
      </button>
    )
  }
})

const initialAppState = useAppStore.getInitialState()
let testRoot: Root
let testContainer: HTMLDivElement
let setCommandQuery: ((next: string) => void) | null = null

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderPalette(overrides: Partial<AppState>): Promise<void> {
  useAppStore.setState({
    activeModal: 'worktree-palette',
    activeWorktreeId: null,
    repos: [makeRepo()],
    tabsByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    unifiedTabsByWorktree: {},
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    // Why explicit: the sweep exemption is what these cases probe, so it must
    // not ride on whatever the store default happens to be.
    alwaysShowDefaultBranchWorkspace: true,
    lastVisitedAtByWorktreeId: {},
    ...overrides
  } as Partial<AppState>)

  await act(async () => {
    testRoot.render(<WorktreeJumpPalette />)
  })
  await flushEffects()
}

function getWorktreeRows(): string[] {
  return [...testContainer.querySelectorAll<HTMLElement>('[data-command-item^="worktree:"]')].map(
    (node) => node.textContent ?? ''
  )
}

describe('WorktreeJumpPalette', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    setCommandQuery = null
    useAppStore.setState(initialAppState, true)
    testContainer = document.createElement('div')
    document.body.appendChild(testContainer)
    testRoot = createRoot(testContainer)
  })

  afterEach(async () => {
    await act(async () => {
      testRoot.unmount()
    })
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
  })

  it('keeps every inactive main workspace visible when sleeping workspaces are hidden', async () => {
    const defaultBranch = makeWorktree('default-branch', 'Default branch workspace', {
      isMainWorktree: true,
      branch: 'refs/heads/main'
    })
    const feature = makeWorktree('feature', 'Feature workspace', {
      branch: 'refs/heads/feature'
    })
    const folderMain = makeWorktree('folder-main', 'Folder workspace', {
      isMainWorktree: true,
      branch: ''
    })

    await renderPalette({
      worktreesByRepo: { 'repo-1': [defaultBranch, feature, folderMain] },
      showSleepingWorkspaces: false
    })

    expect(testContainer.textContent).toContain('Default branch workspace')
    expect(testContainer.textContent).not.toContain('Feature workspace')
    // Why kept: the exemption keys on isMainWorktree, not the branch name, so a
    // branchless folder workspace is the project's entry point too.
    expect(testContainer.textContent).toContain('Folder workspace')
  })

  it('keeps the explicit default-branch filter authoritative', async () => {
    const defaultBranch = makeWorktree('default-branch', 'Default branch workspace', {
      isMainWorktree: true,
      branch: 'refs/heads/main'
    })

    await renderPalette({
      worktreesByRepo: { 'repo-1': [defaultBranch] },
      showSleepingWorkspaces: false,
      hideDefaultBranchWorkspace: true
    })

    expect(testContainer.textContent).not.toContain('Default branch workspace')
  })

  it('keeps an active non-default workspace visible when sleeping workspaces are hidden', async () => {
    const defaultBranch = makeWorktree('default-branch', 'Default branch workspace', {
      isMainWorktree: true,
      branch: 'refs/heads/main'
    })
    const feature = makeWorktree('feature', 'Feature workspace', {
      branch: 'refs/heads/feature'
    })
    const folderMain = makeWorktree('folder-main', 'Folder workspace', {
      isMainWorktree: true,
      branch: ''
    })

    await renderPalette({
      worktreesByRepo: { 'repo-1': [defaultBranch, feature, folderMain] },
      showSleepingWorkspaces: false,
      browserTabsByWorktree: {
        feature: [
          {
            id: 'browser-tab-1',
            worktreeId: 'feature',
            url: 'https://example.com',
            title: 'example.com',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 0
          }
        ]
      }
    })

    expect(testContainer.textContent).toContain('Feature workspace')
    expect(testContainer.textContent).toContain('Default branch workspace')
    // Why kept: same isMainWorktree exemption — folder workspaces are covered.
    expect(testContainer.textContent).toContain('Folder workspace')
  })

  it('sweeps the sleeping main workspace once the exemption is opted out', async () => {
    const defaultBranch = makeWorktree('default-branch', 'Default branch workspace', {
      isMainWorktree: true,
      branch: 'refs/heads/main'
    })
    const feature = makeWorktree('feature', 'Feature workspace', {
      branch: 'refs/heads/feature'
    })

    await renderPalette({
      worktreesByRepo: { 'repo-1': [defaultBranch, feature] },
      showSleepingWorkspaces: false,
      alwaysShowDefaultBranchWorkspace: false
    })

    expect(getWorktreeRows()).toEqual([])
    expect(testContainer.textContent).not.toContain('Default branch workspace')
    expect(testContainer.textContent).not.toContain('Feature workspace')
  })

  it('keeps the show-sleeping baseline and empty-query ordering intact', async () => {
    const defaultBranch = makeWorktree('default-branch', 'Default branch workspace', {
      isMainWorktree: true,
      branch: 'refs/heads/main'
    })
    const feature = makeWorktree('feature', 'Feature workspace', {
      branch: 'refs/heads/feature'
    })
    const folderMain = makeWorktree('folder-main', 'Folder workspace', {
      isMainWorktree: true,
      branch: ''
    })

    await renderPalette({
      worktreesByRepo: { 'repo-1': [defaultBranch, feature, folderMain] },
      showSleepingWorkspaces: true,
      lastVisitedAtByWorktreeId: {
        feature: 300,
        'default-branch': 200,
        'folder-main': 100
      }
    })

    expect(getWorktreeRows()).toEqual([
      expect.stringContaining('Feature workspace'),
      expect.stringContaining('Default branch workspace'),
      expect.stringContaining('Folder workspace')
    ])
  })

  it('keeps typed-query results on the full non-archived scope', async () => {
    const defaultBranch = makeWorktree('default-branch', 'Default branch workspace', {
      isMainWorktree: true,
      branch: 'refs/heads/main'
    })
    const feature = makeWorktree('feature', 'Feature workspace', {
      branch: 'refs/heads/feature'
    })

    await renderPalette({
      worktreesByRepo: { 'repo-1': [defaultBranch, feature] },
      showSleepingWorkspaces: false
    })

    expect(testContainer.textContent).not.toContain('Feature workspace')

    expect(setCommandQuery).not.toBeNull()

    await act(async () => {
      setCommandQuery?.('Feature')
    })
    await flushEffects()

    expect(testContainer.textContent).toContain('Feature workspace')
  })

  it('replaces a completed emoji shortcode in the search query', async () => {
    await renderPalette({ worktreesByRepo: { 'repo-1': [] } })
    const input = testContainer.querySelector<HTMLInputElement>('[data-command-input="true"]')
    expect(input).not.toBeNull()

    await act(async () => {
      fireEvent.change(input!, { target: { value: ':wink:', selectionStart: 6 } })
    })

    expect(input?.value).toBe('😉')
  })
})
