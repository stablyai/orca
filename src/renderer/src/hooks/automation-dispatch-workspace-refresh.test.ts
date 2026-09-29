import { describe, expect, it, vi } from 'vitest'
import type { Automation, AutomationRun } from '../../../shared/automations-types'
import { refreshLocalAutomationDispatchWorkspace } from './automation-dispatch-workspace'

const automation = {
  id: 'automation-1',
  projectId: 'repo-1',
  workspaceId: null
} as Automation

const run = {
  id: 'run-1',
  workspaceDisplayName: null
} as AutomationRun

function makeState(repos: { id: string }[]) {
  return {
    repos,
    allWorktrees: () => [],
    getKnownWorktreeById: () => undefined,
    fetchRepos: vi.fn<() => Promise<void>>(),
    awaitLocalRepoCatalogSettlement: vi.fn<() => Promise<void>>()
  }
}

describe('refreshLocalAutomationDispatchWorkspace', () => {
  it('rereads the store after the local catalog refresh', async () => {
    const refreshed = makeState([{ id: 'repo-1' }])
    const initial = makeState([])
    let current = initial
    initial.fetchRepos.mockImplementation(async () => {
      current = refreshed
    })
    refreshed.awaitLocalRepoCatalogSettlement.mockResolvedValue(undefined)

    const result = await refreshLocalAutomationDispatchWorkspace(
      () => current as never,
      automation,
      run
    )

    expect(initial.fetchRepos).toHaveBeenCalledWith({ runtimeEnvironmentId: null })
    expect(refreshed.awaitLocalRepoCatalogSettlement).toHaveBeenCalledOnce()
    expect(result.state).toBe(refreshed)
    expect(result.resolved.repo?.id).toBe('repo-1')
  })

  it('keeps the target unavailable when the refreshed catalog is still empty', async () => {
    const state = makeState([])
    state.fetchRepos.mockResolvedValue(undefined)
    state.awaitLocalRepoCatalogSettlement.mockResolvedValue(undefined)

    const result = await refreshLocalAutomationDispatchWorkspace(
      () => state as never,
      automation,
      run
    )

    expect(state.fetchRepos).toHaveBeenCalledWith({ runtimeEnvironmentId: null })
    expect(state.awaitLocalRepoCatalogSettlement).toHaveBeenCalledOnce()
    expect(result.resolved.repo).toBeUndefined()
  })
})
