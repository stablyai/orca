import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  HOOK_DONE_QUIET_MS,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'

describe('agent completion coordinator', () => {
  useAgentCompletionCoordinatorLifecycle()

  it('ignores a turn end time that cannot name a turn', () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_000_000
    })
    // Why: NaN/Infinity identify nothing, so a `working` row carrying one is just a working row —
    // announcing on it would raise a banner for a turn that has not ended.
    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_000_000,
      turnCompletedAt: Number.NaN
    })

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('does not announce a gated Stop for a turn it never saw start', () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    // Why: a stamped `working` row replays on activation and worktree switches. Without a
    // `working` of its own first, this coordinator has no evidence the turn ran here at all, so
    // the stamp alone must not mint a banner (#13245).
    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_000_000,
      turnCompletedAt: 1_700_000_005_000
    })

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('pairs a background all-clear with the turn it announced even after a working title blip', () => {
    const dispatchCompletion = vi.fn()
    const dispatchHookLifecycle = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      dispatchHookLifecycle,
      isLive: () => true
    })

    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_000_000
    })
    // Why: Claude's lead Stop ended the turn while a background subagent kept the pane `working`.
    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_000_000,
      turnCompletedAt: 1_700_000_005_000
    })
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    // Why: a working spinner in the title drops the pane-scoped record, so the only thing left
    // that can pair the all-clear with the turn already announced is the coordinator's own
    // identity for it — which is built from the turn end time the all-clear repeats, not from the
    // pane's pinned stateStartedAt, which moved when the row finally reported `done` (#13245).
    vi.advanceTimersByTime(2_000)
    coordinator.observeTitleWorking()

    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_050_000,
      turnCompletedAt: 1_700_000_005_000
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    // Why: recognizing the all-clear must not cost the pane its `done` lifecycle — the turn is
    // over, and cursor/cache release still has to run.
    expect(dispatchHookLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'done', turnCompletedAt: 1_700_000_005_000 })
    )
  })

  it('pairs a background all-clear with the turn it announced across a coordinator remount', () => {
    const dispatchCompletion = vi.fn()
    const firstCoordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    firstCoordinator.observeHookStatus({
      state: 'working',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_000_000
    })
    firstCoordinator.observeHookStatus({
      state: 'working',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_000_000,
      turnCompletedAt: 1_700_000_005_000
    })
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    firstCoordinator.dispose()

    // Why: a worktree switch rebuilds the coordinator while the hook stream stays live, so the
    // fresh one holds no identity of its own. Only the pane-scoped turn end time can tell it the
    // `done` below is the tail of a turn already announced (#13245).
    const dispatchHookLifecycle = vi.fn()
    const remountedCoordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      dispatchHookLifecycle,
      isLive: () => true
    })

    vi.advanceTimersByTime(30_000)
    remountedCoordinator.observeHookStatus({
      state: 'done',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_050_000,
      turnCompletedAt: 1_700_000_005_000
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    // Why: the fresh coordinator can only reach the lifecycle-only drain through the pane-scoped
    // turn end time; the identity dedupe alone would swallow the `done` and the pane would never
    // leave `working`.
    expect(dispatchHookLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'done', turnCompletedAt: 1_700_000_005_000 })
    )
  })

  it('still announces a background turn whose gated Stop lost to an earlier title completion', () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    // Why: a title-driven turn first, so the pane's completion record names the same agent from a
    // different source. That record vetoes the gated Stop below without announcing anything.
    coordinator.observeTitle('⠋ claude')
    vi.advanceTimersByTime(2_000)
    coordinator.observeTitle('claude done')
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2_000)
    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'run the build',
      agentType: 'claude',
      stateStartedAt: 1_700_000_000_000
    })
    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'run the build',
      agentType: 'claude',
      stateStartedAt: 1_700_000_000_000,
      turnCompletedAt: 1_700_000_005_000
    })
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2_000)
    coordinator.observeTitleWorking()

    // Why: the gated Stop never reached the user, so the turn is still unannounced and its
    // all-clear has to raise the banner. A completion mirrored locally before the dispatch
    // committed would make this `done` read as that turn's tail and the turn would go silent.
    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'run the build',
      agentType: 'claude',
      stateStartedAt: 1_700_000_050_000,
      turnCompletedAt: 1_700_000_005_000
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).toHaveBeenCalledTimes(2)
  })
})
