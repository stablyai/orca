import React, { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useStore } from 'zustand'
import { ConfirmationDialogProvider } from '@/components/dismiss/confirmation/confirmation-dialog'
import type {
  ContinueRebaseAction,
  ContinueRebaseRequest,
  ContinueRebaseResult,
  RebaseStopToken
} from '../../../../../../shared/git/status/git-status-types'
import type { GitBranchCompareSummary } from '../../../../../../shared/git/diff/git-diff-compare-types'
import { useSourceControlConflictAbort } from '../sync/use-conflict-abort'
import { useSourceControlRebaseContinue } from '../sync/use-rebase-continue'
import { resolveRebaseContinueState, resolveSourceControlRebaseModel } from './base-rebase-state'
import { SourceControlBranchContextRow } from './branch-context-row'
import { getWorktreeOperationStore } from './worktree-operation-store'

/**
 * A fake repository behind the real Source Control rebase row: the operation store, the Continue and
 * Abort hooks, the state resolver and the row are the shipped code; only Git is simulated. Shared by
 * the happy-dom interaction test and the component fixture driven in headless Chromium.
 */
export type FakeRebaseRepoState = {
  behind: number
  rebasing: boolean
  paused: boolean
  unresolved: number
  head: string
  step: number
  totalSteps: number
  // The current step's resolution left nothing to commit.
  emptyStep: boolean
  inspectFailuresLeft: number
}

export type FakeRebaseCall = { action: ContinueRebaseAction | 'abort'; expected?: RebaseStopToken }

export type FakeRebaseRepo = ReturnType<typeof createFakeRebaseRepo>

const INSPECT_FAILURE = 'WSL distro Ubuntu is not running'

export function createFakeRebaseRepo(
  initial: Partial<FakeRebaseRepoState> = {},
  { delayMs = 0 }: { delayMs?: number } = {}
) {
  let state: FakeRebaseRepoState = {
    behind: 3,
    rebasing: false,
    paused: false,
    unresolved: 0,
    head: 'h0',
    step: 0,
    totalSteps: 2,
    emptyStep: false,
    inspectFailuresLeft: 0,
    ...initial
  }
  const listeners = new Set<() => void>()
  const calls: FakeRebaseCall[] = []
  const set = (patch: Partial<FakeRebaseRepoState>): void => {
    state = { ...state, ...patch }
    for (const listener of listeners) {
      listener()
    }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, delayMs))
  const stop = (): RebaseStopToken => ({
    head: state.head,
    step: String(state.step),
    incarnation: 'rebase-merge:fake'
  })
  const advance = (): ContinueRebaseResult => {
    if (state.step >= state.totalSteps) {
      set({ paused: false, behind: 0, unresolved: 0, emptyStep: false, head: `h${state.step}done` })
      return { outcome: 'completed', branch: 'feature' }
    }
    set({ step: state.step + 1, head: `h${state.step + 1}`, unresolved: 1, emptyStep: false })
    return { outcome: 'conflicted', stop: stop(), branch: 'feature' }
  }

  async function continueRebase({
    action = 'continue',
    expected
  }: { action?: ContinueRebaseAction } & ContinueRebaseRequest): Promise<ContinueRebaseResult> {
    calls.push({ action, expected })
    await settle()
    if (!state.paused) {
      return { outcome: 'not_rebasing' }
    }
    if (action === 'inspect') {
      if (state.inspectFailuresLeft > 0) {
        set({ inspectFailuresLeft: state.inspectFailuresLeft - 1 })
        throw new Error(INSPECT_FAILURE)
      }
      return { outcome: 'inspected', stop: stop(), branch: 'feature' }
    }
    const current = stop()
    if (expected?.head !== current.head || expected?.step !== current.step) {
      return { outcome: 'stale', stop: current, branch: 'feature' }
    }
    if (action === 'continue' && state.emptyStep) {
      return { outcome: 'empty', stop: current, branch: 'feature' }
    }
    return advance()
  }

  async function abortRebase(): Promise<void> {
    calls.push({ action: 'abort' })
    await settle()
    set({ paused: false, unresolved: 0, emptyStep: false, step: 0, head: 'h0' })
  }

  return {
    get: () => state,
    set,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    calls,
    continueRebase,
    abortRebase,
    resolveOneConflict: () => set({ unresolved: Math.max(0, state.unresolved - 1) }),
    startRebase: async () => {
      set({ rebasing: true })
      await settle()
      set({ rebasing: false, paused: true, step: 1, head: 'h1', unresolved: 2 })
    }
  }
}

/** Routes the local Git bridge the hooks call to the fake repository. */
export function installFakeRebaseGit(repo: FakeRebaseRepo): void {
  const api = (window.api ?? {}) as { git?: Record<string, unknown> }
  api.git = {
    ...api.git,
    continueRebase: repo.continueRebase,
    abortRebase: repo.abortRebase
  }
  ;(window as unknown as { api: unknown }).api = api
}

const noopRefresh = async (): Promise<void> => {}
// Stable like the panel's: a fresh object per render would restart the inspect effect each time.
const LOCAL_TARGET = { kind: 'local' as const }
const NOOP_REFRESH_REF = { current: noopRefresh }

function summaryFor(behind: number): GitBranchCompareSummary {
  return {
    baseRef: 'origin/main',
    baseOid: 'base',
    compareRef: 'feature',
    headOid: 'head',
    mergeBase: 'merge-base',
    changedFiles: 3,
    commitsAhead: 4,
    commitsBehind: behind,
    status: 'ready'
  }
}

function RebaseRow({ repo, worktreeId }: { repo: FakeRebaseRepo; worktreeId: string }) {
  const git = useSyncExternalStore(repo.subscribe, repo.get)
  const operationStore = useMemo(
    () => getWorktreeOperationStore(worktreeId, 'local', 'rebase-row-interaction'),
    [worktreeId]
  )
  const rebaseStop = useStore(operationStore, (s) => s.rebaseStop)
  const rebaseStopInspectFailure = useStore(operationStore, (s) => s.rebaseStopInspectFailure)
  const isAbortingOperation = useStore(operationStore, (s) => s.isAbortingOperation)
  const isContinuingRebase = useStore(operationStore, (s) => s.isContinuingRebase)
  const conflictOperation = git.paused ? 'rebase' : 'unknown'
  // Mirrors useSourceControlWorktreeOperationState: an operation change retires the stop reading.
  const observed = useRef(conflictOperation)
  useEffect(() => {
    if (observed.current !== conflictOperation) {
      observed.current = conflictOperation
      operationStore.setState({ rebaseStop: null, rebaseStopInspectFailure: null })
    }
  }, [conflictOperation, operationStore])
  const hookInputs = {
    activeRepoTarget: LOCAL_TARGET,
    activeWorktreeId: worktreeId,
    conflictOperation,
    operationStore,
    refreshActiveGitStatusAfterMutation: noopRefresh,
    refreshBranchCompareRef: NOOP_REFRESH_REF,
    refreshGitHistoryRef: NOOP_REFRESH_REF,
    worktreePath: '/repo'
  } as const
  const { handleAbortRebase } = useSourceControlConflictAbort(hookInputs)
  const { handleContinueRebase, handleRetryRebaseInspect, handleSkipRebaseStep } =
    useSourceControlRebaseContinue({
      ...hookInputs,
      rebaseStopUnread:
        resolveRebaseContinueState(rebaseStop, git.head, rebaseStopInspectFailure) === 'unknown',
      statusHead: git.head
    })
  const { baseRebaseState } = resolveSourceControlRebaseModel({
    summary: summaryFor(git.behind),
    compareBaseRef: 'origin/main',
    effectiveBaseRef: 'origin/main',
    conflictOperation,
    unresolvedConflictCount: git.unresolved,
    hasTrackedChanges: false,
    rebaseAutoStash: null,
    rebaseStop,
    rebaseStopInspectFailure,
    statusHead: git.head,
    isBusy: git.rebasing || isAbortingOperation
  })
  return (
    <SourceControlBranchContextRow
      summary={summaryFor(git.behind)}
      compareBaseRef="origin/main"
      headDisplay={git.paused ? null : { kind: 'branch', branchName: 'feature' }}
      rebase={
        baseRebaseState.kind === 'none'
          ? null
          : {
              state: baseRebaseState,
              isRebasing: git.rebasing,
              isAbortingRebase: isAbortingOperation,
              isContinuingRebase,
              onRebase: () => void repo.startRebase(),
              onAbortRebase: () => void handleAbortRebase(),
              onContinueRebase: () => void handleContinueRebase(),
              onSkipRebaseStep: () => void handleSkipRebaseStep(),
              onRetryRebaseInspect: handleRetryRebaseInspect
            }
      }
      onChangeBaseRef={() => {}}
      onRetry={() => {}}
    />
  )
}

export function RebaseRowInteractionHarness({
  repo,
  worktreeId
}: {
  repo: FakeRebaseRepo
  worktreeId: string
}): React.JSX.Element {
  return (
    <ConfirmationDialogProvider>
      <div className="@container text-[11px]">
        <RebaseRow repo={repo} worktreeId={worktreeId} />
      </div>
    </ConfirmationDialogProvider>
  )
}
