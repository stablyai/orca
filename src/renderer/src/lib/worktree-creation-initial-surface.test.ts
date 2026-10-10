import { describe, expect, it } from 'vitest'
import type { PendingWorktreeCreation } from './pending-worktree-creation'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import {
  createMockStore,
  registerWorktreeActivationReset
} from './worktree-activation-test-harness'

registerWorktreeActivationReset()

function creatingStore() {
  const entry: PendingWorktreeCreation = {
    creationId: 'creation-1',
    worktreeId: 'wt-1',
    phase: 'creating',
    status: 'creating',
    startedAt: 1,
    indeterminate: false,
    loaderVisible: true,
    request: {
      repoId: 'repo-1',
      name: 'workspace',
      setupDecision: 'inherit',
      agent: 'codex',
      pendingFirstAgentMessageRename: false,
      note: '',
      startupPlan: null,
      quickPrompt: '',
      quickTelemetry: null
    }
  }
  return createMockStore({
    settings: {},
    pendingWorktreeCreations: { 'creation-1': entry }
  })
}

describe('initial surface during worktree creation', () => {
  it('does not seed a fallback shell when an unfinished checkout is opened', () => {
    const store = creatingStore()
    expect(ensureWorktreeHasInitialTerminal(store, 'wt-1')).toBeNull()
    expect(store.createTab).not.toHaveBeenCalled()
  })

  it('lets the matching creation owner complete a blank-terminal request', () => {
    const store = creatingStore()
    expect(
      ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, undefined, undefined, undefined, {
        worktreeCreationId: 'creation-1'
      })
    ).toBe('tab-1')
    expect(store.createTab).toHaveBeenCalledOnce()
  })

  it('does not block another workspace or an explicit agent launch', () => {
    const store = creatingStore()
    expect(ensureWorktreeHasInitialTerminal(store, 'wt-other')).toBe('tab-1')
    store.createTab.mockClear()
    expect(
      ensureWorktreeHasInitialTerminal(store, 'wt-1', { command: 'codex', launchAgent: 'codex' })
    ).toBe('tab-1')
    expect(store.createTab).toHaveBeenCalledOnce()
    expect(store.queueTabStartupCommand).toHaveBeenCalledWith('tab-1', {
      command: 'codex',
      launchAgent: 'codex'
    })
  })
})
