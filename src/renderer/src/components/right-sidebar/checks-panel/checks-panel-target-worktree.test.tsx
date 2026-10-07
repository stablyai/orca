// why: the hooks render through React DOM, so @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import { useAppStore } from '@/store'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'
import { makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'

type TerminalHookCall = { defaultActiveWorktree: unknown; isPanelVisible: boolean }

const terminalHook = vi.hoisted(() => {
  const calls: TerminalHookCall[] = []
  return { calls }
})

vi.mock('../use-checks-panel-terminal-worktree', () => ({
  useChecksPanelTerminalWorktree: (args: {
    defaultActiveWorktree: Worktree | null
    isPanelVisible: boolean
  }) => {
    terminalHook.calls.push(args)
    return { worktree: args.defaultActiveWorktree }
  }
}))

import { ChecksPanelTargetProvider } from './checks-panel-target-worktree'
import { useChecksPanelControllerState } from './use-checks-panel-controller-state'
import { useChecksListState } from './use-checks-list-state'

const initialAppState = useAppStore.getInitialState()
const worktreeA = makeWorktree({
  id: 'repo1::/repo1',
  repoId: 'repo1',
  path: '/repo1'
})
const worktreeB = makeWorktree({
  id: 'repo1::/repo1-b',
  repoId: 'repo1',
  path: '/repo1-b'
})

// why: a fresh checks array per render re-runs the list's pruning effect forever
const NO_CHECKS: PRCheckDetail[] = []
const confirmNothing = async (): Promise<boolean> => false

function ConfirmationWrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <ConfirmationDialogContext.Provider value={confirmNothing}>
      {children}
    </ConfirmationDialogContext.Provider>
  )
}

function targetWrapper(worktree: Worktree, isActive: boolean) {
  return function TargetWrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
    return (
      <ConfirmationDialogContext.Provider value={confirmNothing}>
        <ChecksPanelTargetProvider worktree={worktree} isActive={isActive}>
          {children}
        </ChecksPanelTargetProvider>
      </ConfirmationDialogContext.Provider>
    )
  }
}

beforeEach(() => {
  terminalHook.calls = []
  useAppStore.setState(initialAppState, true)
  useAppStore.setState({
    activeWorktreeId: worktreeA.id,
    worktreesByRepo: { repo1: [worktreeA, worktreeB] },
    repos: [{ ...TEST_REPO, kind: 'git', connectionId: null }],
    rightSidebarOpen: true,
    rightSidebarTab: 'checks'
  })
})

afterEach(cleanup)

describe('checks panel target worktree', () => {
  it('follows the active worktree and the terminal without a target', () => {
    const { result } = renderHook(() => useChecksPanelControllerState(), {
      wrapper: ConfirmationWrapper
    })

    expect(result.current.activeWorktreeId).toBe(worktreeA.id)
    expect(result.current.isPanelVisible).toBe(true)
    expect(terminalHook.calls.at(-1)?.isPanelVisible).toBe(true)
  })

  it('reports the target worktree and turns terminal polling off', () => {
    const { result } = renderHook(() => useChecksPanelControllerState(), {
      wrapper: targetWrapper(worktreeB, true)
    })

    expect(result.current.activeWorktreeId).toBe(worktreeB.id)
    expect(result.current.activeWorktree?.path).toBe('/repo1-b')
    expect(result.current.isPanelVisible).toBe(true)
    expect(terminalHook.calls.length).toBeGreaterThan(0)
    expect(terminalHook.calls.every((call) => !call.isPanelVisible)).toBe(true)
  })

  it('hides an inactive target even when the checks tab is open', () => {
    const { result } = renderHook(() => useChecksPanelControllerState(), {
      wrapper: targetWrapper(worktreeB, false)
    })

    expect(result.current.isPanelVisible).toBe(false)
  })

  it('opens check details against the target worktree', () => {
    const { result } = renderHook(
      () =>
        useChecksListState({
          checks: NO_CHECKS,
          checksLoading: false,
          checkDetailsContextKey: 'k'
        }),
      { wrapper: targetWrapper(worktreeB, true) }
    )

    expect(result.current.resolvedWorktreeId).toBe(worktreeB.id)
  })
})
