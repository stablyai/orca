// @vitest-environment happy-dom

import type * as RuntimeGitStatusClientModule from '@/runtime/runtime-git-status-client'
import path from 'node:path'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../../../shared/constants'
import type { GitConflictOperation } from '../../../../../../shared/git-status-types'
import { useSourceControlAi } from './use-ai'
import type { SourceControlAiControllerParams } from './controller-types'
import { deferred } from '../../source-control-hook-test-harness'
const mutationInFlight = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-git-status-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeGitStatusClientModule>()),
  getRuntimeGitMutationInFlight: mutationInFlight
}))

const initialState = useAppStore.getState()

function controllerParams(
  overrides: Partial<SourceControlAiControllerParams> = {}
): SourceControlAiControllerParams {
  return {
    settings: getDefaultSettings(path.resolve('tmp')),
    target: { kind: 'local' },
    activeRepo: null,
    activeWorktreeId: 'wt-1',
    activeConnectionId: null,
    activeGroupId: 'group-1',
    activeSourceControlLaunchPlatform: 'linux',
    conflictOperation: 'rebase',
    unresolvedConflicts: [],
    stagedEntries: [],
    worktreePath: path.resolve('tmp', 'wt-1'),
    commitMessage: '',
    commitError: null,
    pushRecoveryPrompt: null,
    updateSettings: vi.fn(),
    updateRepo: vi.fn(),
    openSettingsTarget: vi.fn(),
    openSettingsPage: vi.fn(),
    ...overrides
  }
}

describe('AI operation recovery composer', () => {
  beforeEach(() => {
    mutationInFlight.mockReset().mockResolvedValue({ inFlight: false })
    useAppStore.setState({ isRemoteOperationActive: false })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it.each<GitConflictOperation>(['merge', 'rebase', 'cherry-pick'])(
    'opens for a paused %s with no unmerged paths',
    async (conflictOperation) => {
      const { result } = renderHook(() =>
        useSourceControlAi(controllerParams({ conflictOperation }))
      )
      await act(() => result.current.handleResolveConflictsWithAI())
      expect(result.current.resolveConflictsComposerOpen).toBe(true)
      expect(result.current.resolveConflictsPrompt).toContain(`- Operation: ${conflictOperation}`)
    }
  )

  it('keeps conflict resolution available without a known operation', async () => {
    const { result } = renderHook(() =>
      useSourceControlAi(
        controllerParams({ conflictOperation: 'unknown', unresolvedConflicts: [{ path: 'a.ts' }] })
      )
    )
    await act(() => result.current.handleResolveConflictsWithAI())
    expect(result.current.resolveConflictsComposerOpen).toBe(true)
  })

  it('does not open when there is no operation or unresolved conflict', async () => {
    const { result } = renderHook(() =>
      useSourceControlAi(controllerParams({ conflictOperation: 'unknown' }))
    )
    await act(() => result.current.handleResolveConflictsWithAI())
    expect(result.current.resolveConflictsComposerOpen).toBe(false)
  })

  it.each([0, 1])(
    'reads execution-host busy state through a retained callback with %i unmerged paths',
    async (unresolvedCount) => {
      const unresolvedConflicts = unresolvedCount ? [{ path: 'a.ts' }] : []
      const { result } = renderHook(() =>
        useSourceControlAi(controllerParams({ unresolvedConflicts }))
      )
      const openComposer = result.current.handleResolveConflictsWithAI
      mutationInFlight.mockResolvedValue({ inFlight: true })
      await act(() => openComposer())
      expect(result.current.resolveConflictsComposerOpen).toBe(false)

      mutationInFlight.mockResolvedValue({ inFlight: false })
      await act(() => openComposer())
      expect(result.current.resolveConflictsComposerOpen).toBe(true)
    }
  )
  it('opens while an unrelated workspace fetch is pending', async () => {
    const { result } = renderHook(() => useSourceControlAi(controllerParams()))
    useAppStore.getState().beginRemoteOperation('fetch')
    await act(() => result.current.handleResolveConflictsWithAI())
    expect(result.current.resolveConflictsComposerOpen).toBe(true)
    expect(mutationInFlight).toHaveBeenCalledWith({
      target: { kind: 'local' },
      worktreeId: 'wt-1',
      worktreePath: path.resolve('tmp', 'wt-1'),
      connectionId: undefined
    })
  })

  it('closes the composer on navigation and keeps it closed when returning', async () => {
    const first = controllerParams()
    const other = controllerParams({
      activeWorktreeId: 'wt-2',
      worktreePath: path.resolve('tmp', 'wt-2')
    })
    const view = renderHook(useSourceControlAi, { initialProps: first })
    await act(() => view.result.current.handleResolveConflictsWithAI())
    expect(view.result.current.resolveConflictsComposerOpen).toBe(true)
    view.rerender(other)
    expect(view.result.current.resolveConflictsComposerOpen).toBe(false)
    view.rerender(first)
    expect(view.result.current.resolveConflictsComposerOpen).toBe(false)
  })

  it.each(['worktree', 'host'] as const)(
    'ignores an old check after leaving and returning to a %s',
    async (change) => {
      const oldCheck = deferred<{ inFlight: boolean }>()
      const newCheck = deferred<{ inFlight: boolean }>()
      mutationInFlight.mockReturnValueOnce(oldCheck.promise).mockReturnValueOnce(newCheck.promise)
      const first = controllerParams()
      const other = controllerParams(
        change === 'worktree'
          ? { activeWorktreeId: 'wt-2', worktreePath: path.resolve('tmp', 'wt-2') }
          : { target: { kind: 'environment', environmentId: 'host-2' } }
      )
      const view = renderHook(useSourceControlAi, { initialProps: first })
      let oldOpening: Promise<void> = Promise.resolve()
      act(() => {
        oldOpening = view.result.current.handleResolveConflictsWithAI()
      })
      view.rerender(other)
      view.rerender(first)
      expect(view.result.current.isCheckingRecoveryAdmission).toBe(false)
      let newOpening: Promise<void> = Promise.resolve()
      act(() => {
        newOpening = view.result.current.handleResolveConflictsWithAI()
      })
      await act(async () => {
        oldCheck.resolve({ inFlight: false })
        await oldOpening
      })
      expect(view.result.current.resolveConflictsComposerOpen).toBe(false)
      expect(view.result.current.isCheckingRecoveryAdmission).toBe(true)
      await act(async () => {
        newCheck.resolve({ inFlight: false })
        await newOpening
      })
      expect(view.result.current.resolveConflictsComposerOpen).toBe(true)
      expect(view.result.current.isCheckingRecoveryAdmission).toBe(false)
    }
  )

  it('cancels a pending check when the composer is closed', async () => {
    const check = deferred<{ inFlight: boolean }>()
    mutationInFlight.mockReturnValue(check.promise)
    const view = renderHook(() => useSourceControlAi(controllerParams()))
    let opening: Promise<void> = Promise.resolve()
    act(() => {
      opening = view.result.current.handleResolveConflictsWithAI()
    })
    act(() => view.result.current.setResolveConflictsComposerOpen(false))
    await act(async () => {
      check.resolve({ inFlight: false })
      await opening
    })
    expect(view.result.current.resolveConflictsComposerOpen).toBe(false)
    expect(view.result.current.isCheckingRecoveryAdmission).toBe(false)
  })
})
