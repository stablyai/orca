import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store/index'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { PendingWorktreeCreation } from './pending-worktree-creation'
import { activateAndRevealWorktree } from '../activation/worktree-activation'
import '../activation/initial-surface/worktree-initial-terminal-seeding'
import { registerWorktreeActivationReset } from '../activation/worktree-activation.test-fixture'

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

describe('initial surface during worktree creation', () => {
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
