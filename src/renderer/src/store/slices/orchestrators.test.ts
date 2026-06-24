import { describe, it, expect, vi } from 'vitest'
import type { Project, TerminalTab, Worktree } from '../../../../shared/types'
import { createTestStore } from './store-test-helpers'
import { ORCASTRATOR_DISPLAY_PREFIX, type OrchestratorEntry } from './orchestrators'

function directorWorktree(id: string, repoId: string, projectName: string): Worktree {
  return {
    id,
    repoId,
    displayName: `${ORCASTRATOR_DISPLAY_PREFIX}${projectName}`
  } as unknown as Worktree
}

function plainWorktree(id: string, repoId: string, displayName: string): Worktree {
  return { id, repoId, displayName } as unknown as Worktree
}

function project(id: string, repoId: string, displayName: string): Project {
  return { id, displayName, sourceRepoIds: [repoId] } as unknown as Project
}

function tab(id: string): TerminalTab {
  return { id } as unknown as TerminalTab
}

function entry(overrides: Partial<OrchestratorEntry> = {}): OrchestratorEntry {
  return {
    id: 'w1',
    projectId: 'p1',
    projectName: 'P1',
    worktreeId: 'w1',
    tabId: 't1',
    launchedAt: 1,
    ...overrides
  }
}

describe('orchestrators slice', () => {
  it('registers, dedupes by id, and removes', () => {
    const store = createTestStore()
    store.getState().registerOrchestrator(entry())
    expect(store.getState().orchestrators).toHaveLength(1)

    // Re-registering the same id replaces (dedupes), not appends.
    store.getState().registerOrchestrator(entry({ projectName: 'P1-updated', tabId: 't2' }))
    expect(store.getState().orchestrators).toHaveLength(1)
    expect(store.getState().orchestrators[0]).toMatchObject({
      projectName: 'P1-updated',
      tabId: 't2'
    })

    store.getState().removeOrchestrator('w1')
    expect(store.getState().orchestrators).toHaveLength(0)
  })

  it('updateOrchestrator renames the matching entry in place and leaves others untouched', () => {
    const store = createTestStore()
    store.getState().registerOrchestrator(entry({ id: 'w1', projectName: 'P1' }))
    store.getState().registerOrchestrator(entry({ id: 'w2', worktreeId: 'w2', projectName: 'P2' }))

    store.getState().updateOrchestrator('w1', { projectName: 'Renamed' })

    const byId = Object.fromEntries(store.getState().orchestrators.map((e) => [e.id, e]))
    expect(byId.w1.projectName).toBe('Renamed')
    expect(byId.w2.projectName).toBe('P2')
  })

  it('reattaches directors from existing worktrees by displayName prefix', () => {
    const store = createTestStore()
    store.setState({
      worktreesByRepo: {
        repo1: [
          plainWorktree('repo1::main', 'repo1', 'main'),
          directorWorktree('repo1::orc', 'repo1', 'My Project')
        ]
      },
      projects: [project('proj1', 'repo1', 'My Project')],
      tabsByWorktree: { 'repo1::orc': [tab('tabA')] }
    })

    store.getState().reattachOrchestrators()

    const orchestrators = store.getState().orchestrators
    expect(orchestrators).toHaveLength(1)
    expect(orchestrators[0]).toMatchObject({
      worktreeId: 'repo1::orc',
      projectId: 'proj1',
      projectName: 'My Project',
      tabId: 'tabA'
    })
  })

  it('reattach prefers the persisted (renamed) worktree name over the project displayName', () => {
    const store = createTestStore()
    // A matching project exists with a DIFFERENT name; the worktree displayName
    // carries the user's rename. Reattach must honor the rename, not the project.
    store.setState({
      worktreesByRepo: { repo1: [directorWorktree('repo1::orc', 'repo1', 'New Name')] },
      projects: [project('proj1', 'repo1', 'Original Project Name')],
      tabsByWorktree: {}
    })

    store.getState().reattachOrchestrators()

    expect(store.getState().orchestrators[0]).toMatchObject({
      worktreeId: 'repo1::orc',
      projectId: 'proj1',
      projectName: 'New Name'
    })
  })

  it('does not reattach non-director worktrees', () => {
    const store = createTestStore()
    store.setState({
      worktreesByRepo: { repo1: [plainWorktree('repo1::main', 'repo1', 'main')] },
      projects: [project('proj1', 'repo1', 'My Project')],
      tabsByWorktree: {}
    })
    store.getState().reattachOrchestrators()
    expect(store.getState().orchestrators).toHaveLength(0)
  })

  it('reattach is idempotent and skips already-registered worktrees', () => {
    const store = createTestStore()
    store.setState({
      worktreesByRepo: { repo1: [directorWorktree('repo1::orc', 'repo1', 'P')] },
      projects: [],
      tabsByWorktree: {}
    })
    store.getState().reattachOrchestrators()
    store.getState().reattachOrchestrators()
    expect(store.getState().orchestrators).toHaveLength(1)
  })

  it('reattach falls back to repo id + stripped name when no project matches', () => {
    const store = createTestStore()
    store.setState({
      worktreesByRepo: { repo1: [directorWorktree('repo1::orc', 'repo1', 'Orphan')] },
      projects: [],
      tabsByWorktree: {}
    })
    store.getState().reattachOrchestrators()
    expect(store.getState().orchestrators[0]).toMatchObject({
      projectId: 'repo1',
      projectName: 'Orphan',
      tabId: ''
    })
  })

  it('closeOrchestrator tears down the worktree and drops the registry entry', async () => {
    const store = createTestStore()
    const removeWorktree = vi.fn().mockResolvedValue(undefined)
    store.setState({ removeWorktree })
    store.getState().registerOrchestrator(entry({ id: 'w1', worktreeId: 'wt1' }))

    await store.getState().closeOrchestrator('w1')

    expect(removeWorktree).toHaveBeenCalledWith('wt1', true)
    expect(store.getState().orchestrators).toHaveLength(0)
  })

  it('closeOrchestrator still drops the entry when worktree removal fails', async () => {
    const store = createTestStore()
    const removeWorktree = vi.fn().mockRejectedValue(new Error('already gone'))
    store.setState({ removeWorktree })
    store.getState().registerOrchestrator(entry({ id: 'w1', worktreeId: 'wt1' }))

    await store.getState().closeOrchestrator('w1')

    expect(store.getState().orchestrators).toHaveLength(0)
  })
})
