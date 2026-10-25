import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import type { PendingWorktreeCreation } from './pending-worktree-creation'
import { activateAndRevealWorktree } from './worktree-activation'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import {
  createMockStore,
  createdTabStartups,
  registerWorktreeActivationReset
} from './worktree-activation.test-fixture'

registerWorktreeActivationReset()

function creatingEntry(): PendingWorktreeCreation {
  return {
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
}

function creatingStore() {
  return createMockStore({
    settings: {},
    pendingWorktreeCreations: { 'creation-1': creatingEntry() }
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
    expect(ensureWorktreeHasInitialTerminal(creatingStore(), 'wt-other')).toBe('tab-1')
    const store = creatingStore()
    expect(
      ensureWorktreeHasInitialTerminal(store, 'wt-1', { command: 'codex', launchAgent: 'codex' })
    ).toBe('tab-1')
    expect(store.createTab).toHaveBeenCalledOnce()
    expect(createdTabStartups(store)['tab-1']).toEqual({ command: 'codex', launchAgent: 'codex' })
  })

  it('shows the creation panel instead of an empty workspace when the row is opened early', () => {
    useAppStore.setState({
      activeView: 'tasks',
      activePendingCreationId: null,
      worktreesByRepo: { 'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1' })] },
      pendingWorktreeCreations: { 'creation-1': { ...creatingEntry(), loaderVisible: false } }
    })

    expect(activateAndRevealWorktree('wt-1')).toEqual({ primaryTabId: null })

    const state = useAppStore.getState()
    expect(state.activePendingCreationId).toBe('creation-1')
    expect(state.activeView).toBe('terminal')
    expect(state.activeWorktreeId).not.toBe('wt-1')
    expect(state.pendingWorktreeCreations['creation-1']?.loaderVisible).toBe(true)
  })
})
