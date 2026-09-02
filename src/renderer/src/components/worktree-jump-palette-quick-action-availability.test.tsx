// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_SCREENCAST_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { buildCmdJActionResults } from '@/components/cmd-j/palette-results'
import { getCmdJQuickActions } from '@/components/cmd-j/quick-actions'
import { useWorktreeJumpPaletteQuickActions } from './use-worktree-jump-palette-quick-actions'

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => RUNTIME_ID
}))
vi.mock('@/components/sidebar/delete-worktree-flow', () => ({ runWorktreeDelete: vi.fn() }))

const RUNTIME_ID = 'runtime-1'
const WORKTREE_ID = 'repo-1::/repo/wt'

function runtimeStatuses(capabilities: string[]): Map<string, unknown> {
  return new Map([[RUNTIME_ID, { status: { capabilities, hostPlatform: 'darwin' } }]])
}

// Every input except runtimeStatusByEnvironmentId keeps a stable identity across rerenders,
// so a recomputation can only come from the runtime status dependency itself.
function buildStableProps() {
  return {
    openModal: vi.fn(),
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn(),
    activeGroupSnapshotRef: createRef<null>(),
    openNewBrowserTabInActiveWorkspace: vi.fn(),
    openNewMarkdownInActiveWorkspace: vi.fn(),
    openNewTerminalTabInActiveWorkspace: vi.fn(),
    actionResults: buildCmdJActionResults(getCmdJQuickActions()),
    activeView: 'terminal',
    activeWorktreeId: WORKTREE_ID,
    worktreesByRepo: mocks.state.worktreesByRepo,
    repos: mocks.state.repos,
    sshConnectionStates: mocks.state.sshConnectionStates,
    activeGroupIdByWorktree: mocks.state.activeGroupIdByWorktree,
    groupsByWorktree: mocks.state.groupsByWorktree,
    isLoading: false,
    settings: mocks.state.settings,
    deferredQuery: 'new browser tab',
    settingsResults: []
  }
}

function renderQuickActions(initialStatuses: Map<string, unknown>) {
  const stable = buildStableProps()
  mocks.state.runtimeStatusByEnvironmentId = initialStatuses
  const harness = renderHook(
    (runtimeStatusByEnvironmentId: Map<string, unknown>) =>
      useWorktreeJumpPaletteQuickActions({ ...stable, runtimeStatusByEnvironmentId } as never),
    { initialProps: initialStatuses }
  )
  return {
    offersBrowserAction: (): boolean =>
      harness.result.current.middleItems.some((item) => item.id === 'quick-action:new-browser-tab'),
    setRuntimeStatuses: (next: Map<string, unknown>): void => {
      mocks.state.runtimeStatusByEnvironmentId = next
      harness.rerender(next)
    }
  }
}

describe('worktree jump palette quick action availability', () => {
  beforeEach(() => {
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    mocks.state = {
      activeView: 'terminal',
      activeWorktreeId: WORKTREE_ID,
      worktreesByRepo: { 'repo-1': [{ id: WORKTREE_ID, repoId: 'repo-1' }] },
      repos: [{ id: 'repo-1' }],
      sshConnectionStates: new Map(),
      activeGroupIdByWorktree: { [WORKTREE_ID]: 'group-1' },
      groupsByWorktree: { [WORKTREE_ID]: [{ id: 'group-1' }] },
      settings: { activeRuntimeEnvironmentId: RUNTIME_ID }
    }
  })
  afterEach(() => {
    delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
  })

  it('drops the paired-web browser action when the runtime loses screencast capability', () => {
    const palette = renderQuickActions(runtimeStatuses([BROWSER_SCREENCAST_RUNTIME_CAPABILITY]))
    expect(palette.offersBrowserAction()).toBe(true)

    palette.setRuntimeStatuses(runtimeStatuses([]))
    expect(palette.offersBrowserAction()).toBe(false)
  })

  it('restores the browser action when a capable runtime comes back', () => {
    const palette = renderQuickActions(runtimeStatuses([]))
    expect(palette.offersBrowserAction()).toBe(false)

    palette.setRuntimeStatuses(runtimeStatuses([BROWSER_SCREENCAST_RUNTIME_CAPABILITY]))
    expect(palette.offersBrowserAction()).toBe(true)
  })
})
