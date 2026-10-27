import { runtimeStatusEntry } from '@/runtime/server-layout-frames.test-fixture'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { getRuntimeAgentInventoryKey } from '@/store/slices/runtime-agent-inventory-key'
import { projectAgentLaunchSettings } from '../../../../../../shared/agent-launch-settings'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { clearHostAgentMenuSettingsForTests } from '@/components/settings/use-host-agent-launch-preferences'
import {
  launchSourceControlRecoveryAgentWithDefault,
  getDefaultSourceControlRecoveryLaunchCopy
} from './recovery-launch'
import { toast } from 'sonner'
// @vitest-environment happy-dom

import type * as RuntimeGitStatusClientModule from '@/runtime/runtime-git-status-client'
import path from 'node:path'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../../../shared/constants'
import type { GitConflictOperation } from '../../../../../../shared/git-status-types'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import { useSourceControlAi } from './use-ai'
import type { SourceControlAiControllerParams } from './controller-types'
import { deferred } from '../../source-control-hook-test-harness'
const { mutationInFlight, detectAgents, launchAgent } = vi.hoisted(() => ({
  mutationInFlight: vi.fn(),
  detectAgents: vi.fn(),
  launchAgent: vi.fn()
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: launchAgent }))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
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
    updateSettingsOrThrow: vi.fn().mockResolvedValue(undefined),
    updateRepo: vi.fn(),
    openSettingsTarget: vi.fn(),
    openSettingsPage: vi.fn(),
    ...overrides
  }
}

describe('AI operation recovery composer', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear()
    hostRpc.mockReset()
    mutationInFlight.mockReset().mockResolvedValue({ inFlight: false })
    detectAgents.mockReset().mockResolvedValue(['codex'])
    launchAgent.mockReset().mockReturnValue({ surface: { kind: 'local-terminal', tabId: 'agent' } })
    setLocalRuntimeCapabilitiesForTests([])
    useAppStore.setState({
      isRemoteOperationActive: false,
      repos: [TEST_REPO],
      worktreesByRepo: { [TEST_REPO.id]: [makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id })] },
      ensureDetectedAgents: async () => {
        const ids: TuiAgent[] = await detectAgents()
        useAppStore.setState({ localDetectedAgentIdsByContext: { host: ids } })
        return ids
      },
      ensureRuntimeDetectedAgents: async (environmentId, worktreeId) => {
        const ids: TuiAgent[] = await detectAgents()
        useAppStore.setState({
          runtimeDetectedAgentIds: { [getRuntimeAgentInventoryKey(environmentId, worktreeId)]: ids }
        })
        return ids
      }
    })
  })

  afterEach(() => {
    cleanup()
    clearHostAgentMenuSettingsForTests()
    setLocalRuntimeCapabilitiesForTests(null)
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

  it.each([false, true])(
    'cold saved recovery respects the host and admission cancellation (%s)',
    async (cancel) => {
      const settings = getDefaultSettings(path.resolve('tmp'))
      settings.disabledTuiAgents = ['codex']
      settings.agentPermissionDefault = 'ask'
      settings.sourceControlAi!.actions = { resolveConflicts: { agentId: 'codex' } }
      const pending = Promise.withResolvers<{
        settings: ReturnType<typeof projectAgentLaunchSettings>
      }>()
      hostRpc.mockReturnValueOnce(pending.promise)
      useAppStore.setState({
        settings,
        repos: [TEST_REPO],
        runtimeStatusByEnvironmentId: new Map([['alpha', runtimeStatusEntry('r1', false)]]),
        worktreesByRepo: {
          [TEST_REPO.id]: [
            makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id, hostId: 'runtime:alpha' })
          ]
        }
      })
      const first = controllerParams({ settings })
      const view = renderHook(useSourceControlAi, { initialProps: first })
      let starting: Promise<void> = Promise.resolve()
      act(() => {
        starting = view.result.current.handleResolveConflictsWithAI()
      })
      await waitFor(() =>
        expect(
          hostRpc.mock.calls.filter((call) => call[1] === 'settings.getAgentLaunch')
        ).toHaveLength(1)
      )
      if (cancel) {
        view.rerender(controllerParams({ activeWorktreeId: 'wt-2', worktreePath: '/wt-2' }))
        await act(async () => {})
        expect(
          hostRpc.mock.calls.find((call) => call[1] === 'settings.getAgentLaunch')?.[3].signal
            .aborted
        ).toBe(true)
      }
      await act(async () => {
        pending.resolve({ settings: projectAgentLaunchSettings({ defaultTuiAgent: 'codex' }) })
        await starting
      })
      expect(launchAgent).toHaveBeenCalledTimes(cancel ? 0 : 1)
      expect(view.result.current.resolveConflictsComposerOpen).toBe(false)
      expect(first.updateSettingsOrThrow).not.toHaveBeenCalled()
      expect(toast.error).not.toHaveBeenCalled()
      if (!cancel) {
        await launchSourceControlRecoveryAgentWithDefault({
          activeWorktreeId: 'wt-1',
          activeGroupId: null,
          activeSourceControlLaunchPlatform: 'linux',
          sourceRepoConnectionId: null,
          actionId: 'fixCommitFailure',
          basePrompt: 'fix',
          getLaunchActionRecipe: () => ({
            agentId: null,
            agentArgs: '--model chosen',
            commandInputTemplate: 'Recovery: {basePrompt}'
          }),
          getStoreState: useAppStore.getState,
          copy: getDefaultSourceControlRecoveryLaunchCopy('commit')
        })
        expect(launchAgent).toHaveBeenLastCalledWith(
          expect.objectContaining({
            agent: 'codex',
            prompt: 'Recovery: fix',
            agentArgs: '-a on-request -s read-only -c approvals_reviewer=user --model chosen'
          })
        )
      }
    }
  )

  it.each(['unavailable', 'error', 'runtime-replaced'] as const)(
    'does not reopen an obsolete fallback when saved discovery ends as %s',
    async (resultKind) => {
      const detection = deferred<TuiAgent[]>()
      detectAgents.mockReturnValueOnce(detection.promise)
      const settings = getDefaultSettings(path.resolve('tmp'))
      settings.sourceControlAi!.actions = { resolveConflicts: { agentId: 'codex' } }
      if (resultKind === 'runtime-replaced') {
        useAppStore.setState({
          runtimeStatusByEnvironmentId: new Map([['alpha', runtimeStatusEntry('r1', false)]]),
          worktreesByRepo: {
            [TEST_REPO.id]: [
              makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id, hostId: 'runtime:alpha' })
            ]
          }
        })
        hostRpc.mockResolvedValue({
          settings: projectAgentLaunchSettings({ defaultTuiAgent: 'codex' })
        })
      }
      const first = controllerParams({ settings })
      const view = renderHook(useSourceControlAi, { initialProps: first })
      let starting: Promise<void> = Promise.resolve()
      act(() => {
        starting = view.result.current.handleResolveConflictsWithAI()
      })
      await waitFor(() => expect(detectAgents).toHaveBeenCalledOnce())
      if (resultKind === 'runtime-replaced') {
        await act(async () => {
          useAppStore.setState({
            runtimeStatusByEnvironmentId: new Map([['alpha', runtimeStatusEntry('r2', false)]])
          })
          await starting
          detection.resolve(['codex'])
        })
        expect(toast.error).not.toHaveBeenCalled()
        expect(first.updateSettingsOrThrow).not.toHaveBeenCalled()
      } else {
        view.rerender(
          controllerParams({ settings, activeWorktreeId: 'wt-2', worktreePath: '/wt-2' })
        )
        view.rerender(first)
      }
      await act(async () => {
        if (resultKind === 'error') {
          detection.reject(new Error('Detection failed'))
        } else if (resultKind === 'unavailable') {
          detection.resolve([])
        }
        await starting
      })
      expect(launchAgent).not.toHaveBeenCalled()
      expect(view.result.current.resolveConflictsComposerOpen).toBe(false)
      expect(view.result.current.isCheckingRecoveryAdmission).toBe(false)
      expect(view.result.current.isResolvingConflictsWithAI).toBe(false)
    }
  )
})

const hostRpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: hostRpc,
  runtimeEnvironmentSupportsCapability: async () => true
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }))
