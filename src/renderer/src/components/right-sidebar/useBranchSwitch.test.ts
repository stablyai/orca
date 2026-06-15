// @vitest-environment happy-dom

import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client'
import { useBranchSwitch } from './useBranchSwitch'
import type { BranchSwitchCandidate } from './branch-switch-candidates'

const mocks = vi.hoisted(() => ({
  switchRuntimeGitBranch: vi.fn(),
  setActiveWorktree: vi.fn(),
  confirm: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
  onSwitched: vi.fn()
}))

vi.mock('@/runtime/runtime-git-client', () => ({
  switchRuntimeGitBranch: mocks.switchRuntimeGitBranch
}))
vi.mock('@/runtime/runtime-repo-client', () => ({
  searchRuntimeRepoBaseRefDetails: vi.fn().mockResolvedValue([])
}))
vi.mock('@/lib/repo-runtime-owner', () => ({
  getRuntimeEnvironmentIdForRepo: () => null
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { setActiveWorktree: typeof mocks.setActiveWorktree }) => unknown) =>
    selector({ setActiveWorktree: mocks.setActiveWorktree })
}))
vi.mock('@/components/confirmation-dialog', () => ({
  useConfirmationDialog: () => mocks.confirm
}))
vi.mock('sonner', () => ({
  toast: {
    warning: mocks.toastWarning,
    error: mocks.toastError,
    success: vi.fn(),
    message: vi.fn()
  }
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

type BranchSwitchState = ReturnType<typeof useBranchSwitch>

let latestState: BranchSwitchState | null = null
const roots: Root[] = []

function HookProbe(): null {
  latestState = useBranchSwitch({
    repoId: 'r',
    worktrees: [],
    activeWorktreeId: null,
    activeBranchName: 'main',
    gitContext: {} as RuntimeGitContext,
    onSwitched: mocks.onSwitched
  })
  return null
}

async function renderHookProbe(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe))
  })
}

function hookState(): BranchSwitchState {
  if (!latestState) {
    throw new Error('Hook state has not been rendered')
  }
  return latestState
}

function candidate(partial: Partial<BranchSwitchCandidate> = {}): BranchSwitchCandidate {
  return {
    refName: 'feature',
    branchName: 'feature',
    kind: 'local',
    isCurrent: false,
    checkedOutInWorktreeId: null,
    checkedOutInWorktreeName: null,
    ...partial
  }
}

describe('useBranchSwitch', () => {
  beforeEach(() => {
    latestState = null
    mocks.switchRuntimeGitBranch.mockReset()
    mocks.setActiveWorktree.mockReset()
    mocks.confirm.mockReset()
    mocks.toastWarning.mockReset()
    mocks.toastError.mockReset()
    mocks.onSwitched.mockReset()
  })

  afterEach(() => {
    roots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
  })

  it('retries with stash when a dirty conflict is confirmed', async () => {
    mocks.switchRuntimeGitBranch
      .mockResolvedValueOnce({ ok: false, reason: 'dirty_conflict' })
      .mockResolvedValueOnce({ ok: true })
    mocks.confirm.mockResolvedValue(true)
    await renderHookProbe()

    await act(async () => {
      await hookState().switchToCandidate(candidate())
    })

    expect(mocks.switchRuntimeGitBranch).toHaveBeenCalledTimes(2)
    expect(mocks.switchRuntimeGitBranch.mock.calls[1][1]).toMatchObject({ mode: 'stash' })
    expect(mocks.onSwitched).toHaveBeenCalled()
  })

  it('does not retry when the dirty conflict is declined', async () => {
    mocks.switchRuntimeGitBranch.mockResolvedValueOnce({ ok: false, reason: 'dirty_conflict' })
    mocks.confirm.mockResolvedValue(false)
    await renderHookProbe()

    await act(async () => {
      await hookState().switchToCandidate(candidate())
    })

    expect(mocks.switchRuntimeGitBranch).toHaveBeenCalledTimes(1)
    expect(mocks.onSwitched).not.toHaveBeenCalled()
  })

  it('surfaces a stash pop conflict as a warning but still reports the switch', async () => {
    mocks.switchRuntimeGitBranch.mockResolvedValueOnce({
      ok: false,
      reason: 'stash_pop_conflict'
    })
    await renderHookProbe()

    await act(async () => {
      await hookState().switchToCandidate(candidate())
    })

    expect(mocks.onSwitched).toHaveBeenCalled()
    expect(mocks.toastWarning).toHaveBeenCalledOnce()
  })

  it('shows the failure message on a failed switch', async () => {
    mocks.switchRuntimeGitBranch.mockResolvedValueOnce({
      ok: false,
      reason: 'failed',
      message: 'boom'
    })
    await renderHookProbe()

    await act(async () => {
      await hookState().switchToCandidate(candidate())
    })

    expect(mocks.toastError).toHaveBeenCalledWith('boom')
  })

  it('guards against overlapping switches from a rapid double-click', async () => {
    let resolveFirst: (value: { ok: true }) => void = () => {}
    const deferred = new Promise<{ ok: true }>((resolve) => {
      resolveFirst = resolve
    })
    mocks.switchRuntimeGitBranch.mockReturnValueOnce(deferred)
    await renderHookProbe()

    await act(async () => {
      const first = hookState().switchToCandidate(candidate())
      const second = hookState().switchToCandidate(candidate())
      resolveFirst({ ok: true })
      await Promise.all([first, second])
    })

    expect(mocks.switchRuntimeGitBranch).toHaveBeenCalledTimes(1)
  })
})
