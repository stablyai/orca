// useShallow skips renders, not selectors; memoize host resolution to avoid per-tab traversal and discarded objects on every publication.
import { beforeEach, describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import {
  resetTerminalPaneHostStateMemoForTests,
  selectTerminalPaneHostState
} from './terminal-pane-host-state'

const LOCAL_WORKTREE = 'repo-1::/repo/worktrees/local'

/** Only the fields the resolver touches; the memo key is the whole object. */
function makeState(overrides: Partial<Record<string, unknown>> = {}): AppState {
  return {
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    runtimeEnvironments: [],
    runtimeStatusByEnvironmentId: new Map(),
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    sshTargetLabels: new Map(),
    removedSshTargetLabels: new Map(),
    sshTargetsHydrated: true,
    sshTargets: [],
    ...overrides
  } as unknown as AppState
}

beforeEach(() => {
  resetTerminalPaneHostStateMemoForTests()
})

describe('selectTerminalPaneHostState memo', () => {
  it('releases the last store snapshot when no terminal selects again', async () => {
    if (typeof globalThis.gc !== 'function') {
      throw new Error('Run with the repository Vitest --expose-gc config')
    }
    function selectRetiredState(): WeakRef<AppState> {
      const state = makeState()
      selectTerminalPaneHostState(state, LOCAL_WORKTREE)
      return new WeakRef(state)
    }
    const retired = selectRetiredState()
    for (let round = 0; round < 3; round++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      globalThis.gc()
    }
    expect(retired.deref()).toBeUndefined()
  })
})
