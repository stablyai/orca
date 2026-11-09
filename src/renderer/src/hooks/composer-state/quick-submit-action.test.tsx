// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useQuickSubmitAction } from './quick-submit-action'

afterEach(cleanup)

type QuickSubmitActionInput = Parameters<typeof useQuickSubmitAction>[0]

function renderQuickSubmit(overrides: Partial<QuickSubmitActionInput>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the omitted repo and target fields are not read before the reveal; the real store starts with no pending creations.
  const input = {
    effectiveLinkedPR: null,
    executeQuickCreation: vi.fn(),
    fallbackCreatureName: 'otter',
    isProjectGroupTarget: false,
    isSubmissionCancelled: () => false,
    linkedPR: null,
    linkedWorkItem: null,
    name: 'feature',
    onCreated: vi.fn(),
    parsedLinkedIssueNumber: null,
    repoId: 'repo-1',
    requiresExplicitSetupChoice: false,
    resolvePendingSmartGitHubSubmit: vi.fn(),
    selectedRepo: { id: 'repo-1', path: '/repo' },
    selectedRepoRequiresConnection: false,
    selectedTargetNeedsVisibleHost: false,
    selectedWorkspaceTarget: { status: 'none' },
    revealSetupChoice: vi.fn(),
    setCreateError: vi.fn(),
    setCreating: vi.fn(),
    setupDecision: null,
    showProjectRequiredError: vi.fn(),
    sourceIntentBlocksCreate: false,
    sparseError: null,
    submitFolderTarget: vi.fn(),
    taskSourceContext: null,
    telemetrySource: 'sidebar',
    ...overrides
  } as unknown as QuickSubmitActionInput
  const { result } = renderHook(() => useQuickSubmitAction(input))
  return { input, submitQuick: result.current.submitQuick }
}

describe('useQuickSubmitAction setup choice', () => {
  it('reveals the hidden Run/Skip choice instead of refusing a submit with no decision', async () => {
    const { input, submitQuick } = renderQuickSubmit({ requiresExplicitSetupChoice: true })

    await act(() => submitQuick(null))

    expect(input.revealSetupChoice).toHaveBeenCalledTimes(1)
    expect(input.setCreating).not.toHaveBeenCalled()
    expect(input.executeQuickCreation).not.toHaveBeenCalled()
  })
})
