import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingWorktreeCreation, WorktreeCreationRequest } from './pending-worktree-creation'

const mocks = vi.hoisted(() => ({
  ensureHooksConfirmed: vi.fn(),
  readAndConfirmRuntimeIssueCommand: vi.fn(),
  buildTrustedComposerIssueCommand: vi.fn()
}))
vi.mock('./ensure-hooks-confirmed', () => mocks)
vi.mock('./composer-issue-command', () => mocks)

const pendingWorktreeCreations: Record<string, PendingWorktreeCreation> = {}
const store = {
  pendingWorktreeCreations,
  updatePendingWorktreeCreation: vi.fn(),
  removePendingWorktreeCreation: vi.fn()
}
vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))

import { prepareWorktreeCreationHooks } from './worktree-creation-hook-preparation'

function makeRequest(): WorktreeCreationRequest {
  return {
    repoId: 'repo-1',
    name: 'issue-42',
    agent: null,
    setupDecision: 'run',
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null,
    hookPreparation: {
      executionHostId: 'ssh:remote-1',
      issueCommand: { provider: 'github', issueNumber: 42, artifactUrl: 'https://example.test/42' }
    }
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  const request = makeRequest()
  store.pendingWorktreeCreations = {
    'creation-1': {
      creationId: 'creation-1',
      phase: 'preparing',
      status: 'creating',
      startedAt: 0,
      indeterminate: false,
      loaderVisible: true,
      request
    }
  }
  mocks.ensureHooksConfirmed.mockResolvedValue('run')
})

describe('worktree script preparation', () => {
  it('reads and confirms issue commands on the selected host before advancing', async () => {
    const read = Promise.withResolvers<{ template: string; trustDecision: 'run' }>()
    mocks.readAndConfirmRuntimeIssueCommand.mockReturnValue(read.promise)
    mocks.buildTrustedComposerIssueCommand.mockReturnValue({ command: 'issue 42' })
    const preparing = prepareWorktreeCreationHooks('creation-1', makeRequest())
    await vi.waitFor(() => expect(mocks.readAndConfirmRuntimeIssueCommand).toHaveBeenCalled())
    expect(store.updatePendingWorktreeCreation).not.toHaveBeenCalled()
    expect(mocks.readAndConfirmRuntimeIssueCommand).toHaveBeenCalledWith(
      store,
      'repo-1',
      'ssh:remote-1',
      expect.any(Function)
    )
    read.resolve({ template: 'issue {{number}}', trustDecision: 'run' })
    expect(await preparing).toMatchObject({
      issueCommand: { command: 'issue 42' },
      executionHostId: 'ssh:remote-1',
      hookPreparation: undefined
    })
    expect(mocks.buildTrustedComposerIssueCommand).toHaveBeenCalledWith({
      enabled: true,
      provider: 'github',
      issueNumber: 42,
      artifactUrl: 'https://example.test/42',
      template: 'issue {{number}}',
      trustDecision: 'run'
    })
  })

  it('does not inspect issue commands when setup trust was refused', async () => {
    mocks.ensureHooksConfirmed.mockResolvedValue('skip')
    expect(await prepareWorktreeCreationHooks('creation-1', makeRequest())).toMatchObject({
      setupDecision: 'skip'
    })
    expect(mocks.readAndConfirmRuntimeIssueCommand).not.toHaveBeenCalled()
  })

  it('does not advance after cancelling an issue-command confirmation', async () => {
    const read = Promise.withResolvers<{ template: string; trustDecision: 'run' }>()
    mocks.readAndConfirmRuntimeIssueCommand.mockReturnValue(read.promise)
    const preparing = prepareWorktreeCreationHooks('creation-1', makeRequest())
    await vi.waitFor(() => expect(mocks.readAndConfirmRuntimeIssueCommand).toHaveBeenCalled())
    delete store.pendingWorktreeCreations['creation-1']
    read.resolve({ template: 'issue {{number}}', trustDecision: 'run' })
    expect(await preparing).toBeNull()
    expect(store.updatePendingWorktreeCreation).not.toHaveBeenCalled()
  })

  it('removes the preparation when the VM recipe is refused', async () => {
    mocks.ensureHooksConfirmed.mockResolvedValueOnce('run').mockResolvedValueOnce('skip')
    const request = makeRequest()
    request.hookPreparation = { executionHostId: 'ssh:remote-1', confirmVmRecipe: true }
    expect(await prepareWorktreeCreationHooks('creation-1', request)).toBeNull()
    expect(mocks.ensureHooksConfirmed).toHaveBeenLastCalledWith(
      expect.any(Function),
      'repo-1',
      'vmRecipe',
      'ssh:remote-1',
      undefined,
      expect.any(Function)
    )
    expect(store.removePendingWorktreeCreation).toHaveBeenCalledWith('creation-1')
    expect(store.updatePendingWorktreeCreation).not.toHaveBeenCalled()
  })
})
