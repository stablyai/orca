import { create } from 'zustand'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClaudeWorkflowDetailSlice } from './claude-workflow-detail'
import type { ClaudeWorkflowDetailTarget } from '../../../../shared/claude-workflow-detail'

function makeTarget(
  overrides: Partial<ClaudeWorkflowDetailTarget> = {}
): ClaudeWorkflowDetailTarget {
  return {
    paneKey: 'tab-1:leaf-1',
    worktreeId: 'repo::/repo/work',
    connectionId: null,
    worktreePath: '/repo/work',
    state: 'working',
    prompt: 'Prompt',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    agentType: 'claude',
    ...overrides
  }
}

function createDetailStore() {
  return create<ReturnType<typeof createClaudeWorkflowDetailSlice>>()((...a) =>
    createClaudeWorkflowDetailSlice(...(a as Parameters<typeof createClaudeWorkflowDetailSlice>))
  )
}

describe('claude workflow detail slice', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('invalidates cached detail when row timestamps advance', async () => {
    const getDetail = vi.fn(async ({ target }: { target: ClaudeWorkflowDetailTarget }) => ({
      target,
      summaryOnly: true,
      source: 'summary-only' as const,
      warnings: [],
      timeline: [],
      agents: []
    }))
    vi.stubGlobal('window', { api: { claudeWorkflows: { getDetail } } })
    const store = createDetailStore()

    store.getState().openClaudeWorkflowDetail(makeTarget({ updatedAt: 1 }))
    await Promise.resolve()
    store.getState().openClaudeWorkflowDetail(makeTarget({ updatedAt: 2 }))
    await Promise.resolve()

    expect(getDetail).toHaveBeenCalledTimes(2)
  })

  it('drops stale in-flight responses after selected target changes', async () => {
    let resolveFirst: (() => void) | undefined
    const getDetail = vi
      .fn()
      .mockImplementationOnce(
        ({ target }: { target: ClaudeWorkflowDetailTarget }) =>
          new Promise((resolve) => {
            resolveFirst = () => {
              resolve({
                target,
                summaryOnly: true,
                source: 'summary-only',
                warnings: [],
                timeline: [],
                agents: []
              })
            }
          })
      )
      .mockImplementationOnce(async ({ target }: { target: ClaudeWorkflowDetailTarget }) => ({
        target,
        summaryOnly: true,
        source: 'summary-only',
        warnings: ['second'],
        timeline: [],
        agents: []
      }))
    vi.stubGlobal('window', { api: { claudeWorkflows: { getDetail } } })
    const store = createDetailStore()

    store.getState().openClaudeWorkflowDetail(makeTarget({ paneKey: 'tab-1:leaf-1' }))
    store.getState().openClaudeWorkflowDetail(makeTarget({ paneKey: 'tab-1:leaf-2' }))
    await Promise.resolve()
    resolveFirst?.()
    await Promise.resolve()

    expect(store.getState().claudeWorkflowDetailStatus.detail?.warnings).toEqual(['second'])
  })
})
